/// <reference lib="webworker" />
/**
 * All heavy work runs here, off the page thread: OpenCV, the recogniser, harvesting and rendering.
 * Nothing leaves the device: images and models are processed locally.
 */
import * as ort from 'onnxruntime-web/wasm';
import { loadCV } from '../core/cv';
import * as cvx from '../core/cv';
import { parseStem } from '../core/charset';
import { agrees, analyzeImage, extractLine, ImageAnalysis, normalizeGlyph } from '../core/harvest';
import { Glyph, upgradeLegacy } from '../core/library';
import { CtcRecognizer } from '../core/ocr/ctc';
import { PdfImage, PdfRule, PdfWriter } from '../core/pdf';
import { decodePng, encodePng } from '../core/png';
import { DEFAULT_OPTIONS, layoutText, RenderCache, renderLine, SynthOptions } from '../core/synth/engine';
import { RGBA } from '../core/types';
import type { CheckItem, Commands, LineInfo, Paper, Request, Response } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let ocr: CtcRecognizer | null = null;
let image: RGBA | null = null;
let imageName = '';
let analysis: ImageAnalysis | null = null;
let library: Glyph[] = [];

type Progress = (done: number, total: number, note?: string) => void;
type Handler<C extends keyof Commands> = (args: Commands[C]['args'], progress: Progress) => Promise<{ result: Commands[C]['result']; transfer?: Transferable[] }>;

async function fetchModel(url: string, progress: Progress, keep: boolean): Promise<Uint8Array | null> {
  const cache = keep && 'caches' in ctx ? await caches.open('hw-models-v1') : null;
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  let res: globalThis.Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
  const total = Number(res.headers.get('content-length')) || 0;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) return null; // a static server answering with its index page
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    parts.push(value);
    done += value.length;
    progress(done, total, 'загрузка модели');
  }
  const bytes = new Uint8Array(done);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  if (bytes.length < 1_000_000) return null;
  if (cache) await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => undefined);
  return bytes;
}

function ruling(paper: Paper, o: SynthOptions): PdfRule[] {
  if (paper === 'blank') return [];
  const rules: PdfRule[] = [];
  const rgb: [number, number, number] = [168, 196, 226];
  const step = paper === 'squared' ? 5 : o.rowMm;
  // text baselines sit on the ruling: the first one is one row below the top margin
  const y0 = o.marginTopMm % step;
  for (let y = y0; y < o.pageHmm; y += step) rules.push({ x1: 0, y1: y, x2: o.pageWmm, y2: y, rgb, widthMm: 0.12 });
  if (paper === 'squared') for (let x = step; x < o.pageWmm; x += step) rules.push({ x1: x, y1: 0, x2: x, y2: o.pageHmm, rgb, widthMm: 0.12 });
  return rules;
}

function blit(dst: Uint8Array, W: number, H: number, src: Uint8Array, w: number, h: number, ox: number, oy: number) {
  for (let y = 0; y < h; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < w; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= W) continue;
      const s = 4 * (y * w + x);
      const a = src[s + 3] / 255;
      if (!a) continue;
      const t = 4 * (ty * W + tx);
      dst[t] = Math.round(src[s] * a + dst[t] * (1 - a));
      dst[t + 1] = Math.round(src[s + 1] * a + dst[t + 1] * (1 - a));
      dst[t + 2] = Math.round(src[s + 2] * a + dst[t + 2] * (1 - a));
    }
  }
}

const handlers: { [C in keyof Commands]: Handler<C> } = {
  async init() {
    await loadCV();
    return { result: { ok: true } };
  },

  async loadOcr({ urls, ortPath, keep }, progress) {
    // only the .wasm file is fetched; the JavaScript part of the runtime is inside the bundle
    ort.env.wasm.wasmPaths = { wasm: `${ortPath}ort-wasm-simd-threaded.wasm` };
    ort.env.wasm.numThreads = 1;
    for (const url of urls) {
      const bytes = await fetchModel(url, progress, keep);
      if (!bytes) continue;
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      ocr = new CtcRecognizer(ort as never, session as never);
      return { result: { source: url } };
    }
    throw new Error('Модель распознавания не найдена. Нужен файл models/ocr_model.onnx рядом с программой или доступ в интернет при первом запуске.');
  },

  async analyze({ rgba, width, height, name }, progress) {
    image = { width, height, data: rgba };
    imageName = name;
    analysis = await analyzeImage(image, ocr ?? undefined, (d, t) => progress(d, t, 'строки'));
    const lines: LineInfo[] = [];
    const transfer: Transferable[] = [];
    analysis.lines.forEach((la, index) => {
      const st = la.strip;
      const f = Math.min(1, 132 / st.height);
      const w = Math.max(1, Math.round(st.width * f));
      const h = Math.max(1, Math.round(st.height * f));
      const preview = f < 1 ? cvx.resize(st.rgba, st.width, st.height, w, h, 'area', 4) : new Uint8Array(st.rgba);
      lines.push({ index, text: la.text, preview, width: w, height: h, baseY: st.baseY * f, xh: st.xh * f });
      transfer.push(preview.buffer);
    });
    const p = analysis.page;
    return {
      result: {
        lines, skewDeg: p.skewDeg, pxPerMm: p.pxPerMm, strokeWidth: p.strokeWidth, xHeight: p.xHeight,
        ruling: p.ruling ? (p.ruling.squared ? 'клетка' : 'линейка') : 'нет',
      },
      transfer,
    };
  },

  async extract({ line, text, widths }, progress) {
    if (!analysis) throw new Error('Сначала выберите фото');
    const la = analysis.lines[line];
    const r = await extractLine(la, text, ocr ?? undefined, {
      file: imageName, pxPerMm: analysis.page.pxPerMm, widths: new Map(widths), onProgress: (d, t) => progress(d, t, 'проверка букв'),
    });
    const glyphs = r.glyphs.map((g) => ({ meta: g.meta, png: encodePng(g.rgba, g.meta.width, g.meta.height) }));
    return { result: { glyphs }, transfer: glyphs.map((g) => g.png.buffer) };
  },

  async setLibrary({ glyphs }) {
    library = glyphs.map((g) => {
      const d = decodePng(g.png);
      return { meta: { ...g.meta, id: g.id, width: d.width, height: d.height }, rgba: d.rgba };
    });
    return { result: { count: library.length } };
  },

  /** A glyph from the old program's folder: PNG (often without transparency) plus optional JSON. */
  async importPng({ png, json, stem }) {
    const d = decodePng(png);
    let parsed: Record<string, unknown> = {};
    if (json) try { parsed = JSON.parse(json); } catch { parsed = {}; }
    const named = parseStem(stem);
    const char = typeof parsed.char === 'string' ? (parsed.char as string) : named?.char;
    if (!char) return { result: null };
    let opaque = true;
    for (let i = 3; i < d.rgba.length; i += 4) if (d.rgba[i] < 250) { opaque = false; break; }
    if (opaque) {
      // paper → transparency
      for (let i = 0; i < d.rgba.length; i += 4) {
        const dark = 255 - Math.min(d.rgba[i], d.rgba[i + 1], d.rgba[i + 2]);
        const a = Math.max(0, Math.min(1, (dark - 18) / 110));
        d.rgba[i + 3] = Math.round(255 * a);
      }
    }
    const meta = upgradeLegacy(parsed, char, named?.variant ?? 1, d.width, d.height);
    const g = normalizeGlyph({ meta, rgba: d.rgba });
    const out = encodePng(g.rgba, g.meta.width, g.meta.height);
    return { result: { meta: g.meta, png: out }, transfer: [out.buffer] };
  },

  async preview({ text, options, page, dpi, paper }) {
    const opts = { ...DEFAULT_OPTIONS, ...options, dpi };
    const lay = layoutText(text, library, opts);
    const ppm = dpi / 25.4;
    const W = Math.round(opts.pageWmm * ppm);
    const H = Math.round(opts.pageHmm * ppm);
    const rgba = new Uint8Array(W * H * 4).fill(255);
    for (const r of ruling(paper, opts)) {
      const horizontal = r.y1 === r.y2;
      if (horizontal) {
        const y = Math.round(r.y1 * ppm);
        if (y >= 0 && y < H) for (let x = 0; x < W; x++) { const t = 4 * (y * W + x); rgba[t] = r.rgb[0]; rgba[t + 1] = r.rgb[1]; rgba[t + 2] = r.rgb[2]; }
      } else {
        const x = Math.round(r.x1 * ppm);
        if (x >= 0 && x < W) for (let y = 0; y < H; y++) { const t = 4 * (y * W + x); rgba[t] = r.rgb[0]; rgba[t + 1] = r.rgb[1]; rgba[t + 2] = r.rgb[2]; }
      }
    }
    const pg = lay.pages[Math.min(page, lay.pages.length - 1)];
    const cache = new RenderCache();
    for (const ln of pg.lines) {
      const r = renderLine(ln, opts, cache);
      if (r) blit(rgba, W, H, r.rgba, r.width, r.height, r.x, r.y);
    }
    return { result: { rgba, width: W, height: H, pages: lay.pages.length, missing: lay.missing }, transfer: [rgba.buffer] };
  },

  async pdf({ text, options, paper }, progress) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const lay = layoutText(text, library, opts);
    const ppm = opts.dpi / 25.4;
    const pdf = new PdfWriter(opts.pageWmm, opts.pageHmm);
    const cache = new RenderCache();
    const total = lay.pages.reduce((n, p) => n + p.lines.length, 0);
    let done = 0;
    for (const pg of lay.pages) {
      const images: PdfImage[] = [];
      for (const ln of pg.lines) {
        // one line at a time: memory stays at the size of a single line strip
        const r = renderLine(ln, opts, cache);
        if (r) images.push({ rgba: r.rgba, width: r.width, height: r.height, xMm: r.x / ppm, yMm: r.y / ppm, wMm: r.width / ppm, hMm: r.height / ppm });
        progress(++done, total, 'строки');
      }
      pdf.addPage(images, ruling(paper, opts));
    }
    const parts = pdf.finish();
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    return { result: { bytes, pages: lay.pages.length, missing: lay.missing }, transfer: [bytes.buffer] };
  },

  /** Reads the rendered words back with the recogniser and reports those that do not match the text. */
  async check({ text, options, page }, progress) {
    if (!ocr) throw new Error('Модель распознавания не загружена');
    const opts = { ...DEFAULT_OPTIONS, ...options, dpi: 250 };
    const lay = layoutText(text, library, opts);
    const pg = lay.pages[Math.min(page, lay.pages.length - 1)];
    const items: CheckItem[] = [];
    const cache = new RenderCache();
    const total = pg.lines.reduce((n, l) => n + l.words.length, 0);
    let done = 0;
    const canonWord = (s: string) => [...s].filter((c) => /[\p{L}\p{N}]/u.test(c)).join('').toLowerCase().replace(/ё/g, 'е');
    for (let li = 0; li < pg.lines.length; li++) {
      const ln = pg.lines[li];
      const r = renderLine(ln, opts, cache);
      if (!r) continue;
      for (const wd of ln.words) {
        const x0 = Math.max(0, Math.floor(wd.x0 - r.x) - 4);
        const x1 = Math.min(r.width, Math.ceil(wd.x1 - r.x) + 4);
        const w = x1 - x0;
        progress(++done, total, 'проверка слов');
        if (w < 4) continue;
        const crop = new Uint8Array(w * r.height * 4).fill(250);
        for (let k = 3; k < crop.length; k += 4) crop[k] = 255;
        let any = false;
        for (let y = 0; y < r.height; y++) for (let x = 0; x < w; x++) {
          const s = 4 * (y * r.width + x0 + x);
          const a = r.rgba[s + 3] / 255;
          if (!a) continue;
          any = true;
          const t = 4 * (y * w + x);
          for (let c = 0; c < 3; c++) crop[t + c] = Math.round(r.rgba[s + c] * a + 250 * (1 - a));
        }
        if (!any) continue;
        const read = (await ocr.read(crop, w, r.height)).text;
        const want = canonWord(wd.text);
        const ok = want.length === 0 || canonWord(read) === want || (want.length === 1 && agrees(want, read));
        items.push({ line: li, word: wd.text, read, ok });
      }
    }
    return { result: { items } };
  },
};

ctx.onmessage = async (e: MessageEvent<Request>) => {
  const { id, cmd, args } = e.data;
  const progress: Progress = (done, total, note) => ctx.postMessage({ id, progress: { done, total, note } } satisfies Response);
  try {
    const h = handlers[cmd] as Handler<typeof cmd>;
    const { result, transfer } = await h(args as never, progress);
    ctx.postMessage({ id, result } satisfies Response, transfer ?? []);
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
