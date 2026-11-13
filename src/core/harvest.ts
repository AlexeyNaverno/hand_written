/**
 * Harvesting letters from a photo of an ordinary handwritten page:
 * page → lines → (recognised text, corrected by the user) → letters with baseline and joints.
 * Every cut-out letter is read again by the recogniser alone; only letters it reads as expected are accepted
 * automatically. The document is redundant, so doubtful letters are simply not taken.
 */
import * as cv from './cv';
import { alignText, CharPlace } from './analyze/align';
import { extractGlyphs } from './analyze/glyph';
import { analyzeLine, LineAnalysis } from './analyze/line';
import { analyzePage, PageAnalysis } from './analyze/page';
import { isJoining } from './charset';
import { Glyph, Joint } from './library';
import { CtcRecognizer } from './ocr/ctc';
import { RGBA } from './types';

export interface ImageAnalysis {
  page: PageAnalysis;
  lines: LineAnalysis[];
}

export async function analyzeImage(img: RGBA, ocr?: CtcRecognizer, onProgress?: (done: number, total: number) => void): Promise<ImageAnalysis> {
  const page = analyzePage(img);
  const usable = page.lines.filter((l) => !l.partial);
  const lines: LineAnalysis[] = [];
  for (let i = 0; i < usable.length; i++) {
    lines.push(await analyzeLine(img, page, usable[i], ocr));
    onProgress?.(i + 1, usable.length);
  }
  return { page, lines };
}

/** Letters are stored with lowercase height of at most this many pixels: enough for 600 dpi output. */
const STORE_XH = 64;

function scaleJoint(j: Joint | null, f: number): Joint | null {
  if (!j) return null;
  return { ...j, p0: [j.p0[0] * f, j.p0[1] * f], p1: [j.p1[0] * f, j.p1[1] * f], width: Math.round(j.width * f * 10) / 10 };
}

export function normalizeGlyph(g: Glyph): Glyph {
  const m = g.meta;
  const f = STORE_XH / m.x_height;
  if (f >= 1) return g;
  const w = Math.max(2, Math.round(m.width * f));
  const h = Math.max(2, Math.round(m.height * f));
  const fx = w / m.width;
  const fy = h / m.height;
  const pre = new Uint8Array(g.rgba);
  for (let i = 0; i < pre.length; i += 4) {
    const a = pre[i + 3] / 255;
    pre[i] = Math.round(pre[i] * a); pre[i + 1] = Math.round(pre[i + 1] * a); pre[i + 2] = Math.round(pre[i + 2] * a);
  }
  const out = cv.resize(pre, m.width, m.height, w, h, 'area', 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255;
    if (a > 0) { out[i] = Math.min(255, Math.round(out[i] / a)); out[i + 1] = Math.min(255, Math.round(out[i + 1] / a)); out[i + 2] = Math.min(255, Math.round(out[i + 2] / a)); }
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    rgba: out,
    meta: {
      ...m, width: w, height: h,
      bbox: [r1(m.bbox[0] * fx), r1(m.bbox[1] * fy), r1(m.bbox[2] * fx), r1(m.bbox[3] * fy)],
      baseline: r1(m.baseline * fy), x_height: r1(m.x_height * fy), stroke_width: r1(m.stroke_width * f),
      entry: scaleJoint(m.entry, f), exit: scaleJoint(m.exit, f),
      source: { ...m.source, px_per_mm: m.source.px_per_mm ? m.source.px_per_mm * f : null },
    },
  };
}

const LOOKALIKE: Record<string, string> = { '0': 'о', 'o': 'о', 'O': 'о', 'О': 'о', '3': 'з', 'З': 'з', 'c': 'с', 'C': 'с', 'С': 'с', 'a': 'а', 'e': 'е', 'p': 'р', 'x': 'х', 'y': 'у', 'k': 'к', 'K': 'к', 'К': 'к', 'm': 'м', 'M': 'м', 'М': 'м', 'T': 'т', 'Т': 'т', 'H': 'н', 'Н': 'н', 'B': 'в', 'В': 'в', '—': '-', '–': '-', '_': '-' };
/** A cut-out letter is accepted automatically only when the recogniser is this sure of it. */
const MIN_PROB = 0.85;
const canon = (ch: string) => LOOKALIKE[ch] ?? LOOKALIKE[ch.toLowerCase()] ?? ch.toLowerCase();

/**
 * Does the recogniser's reading of a single cut-out letter agree with the expected character?
 * The reading must be exactly that one character: an extra dot or letter means the cut-out contains something else.
 */
export function agrees(expected: string, read: string): boolean {
  return [...read.trim()].map(canon).join('') === canon(expected);
}

/** The glyph alone on white paper, as a one-letter "word" for the recogniser. */
export async function verifyGlyph(g: Glyph, ocr: CtcRecognizer): Promise<{ ok: boolean; read: string; p: number }> {
  const m = g.meta;
  const padX = Math.round(0.35 * m.x_height);
  const top = Math.round(Math.max(m.baseline, 1.5 * m.x_height) + 0.3 * m.x_height);
  const bot = Math.round(Math.max(m.height - m.baseline, 0.6 * m.x_height) + 0.2 * m.x_height);
  const W = m.width + 2 * padX;
  const H = top + bot;
  const im = new Uint8Array(W * H * 4).fill(250);
  for (let k = 3; k < im.length; k += 4) im[k] = 255;
  for (let y = 0; y < m.height; y++) {
    const ty = Math.round(top - m.baseline) + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < m.width; x++) {
      const s = 4 * (y * m.width + x);
      const a = g.rgba[s + 3] / 255;
      if (!a) continue;
      const t = 4 * (ty * W + padX + x);
      for (let c = 0; c < 3; c++) im[t + c] = Math.round(g.rgba[s + c] * a + 250 * (1 - a));
    }
  }
  const r = await ocr.read(im, W, H);
  // look-alikes (о/О/0, с/С/c, у/y …) share the evidence: the recogniser cannot tell them apart in a single letter
  const want = canon(m.char);
  const classes = [...ocr.config.alphabet].filter((c) => canon(c) === want).map((c) => ocr.classOf(c)!);
  let p = 0;
  for (let f = 0; f < r.frames; f++) {
    let sum = 0;
    for (const c of classes) sum += r.probs[f * r.classes + c];
    p = Math.max(p, sum);
  }
  // characters the recogniser does not know by themselves (Й, Ъ, some signs) are judged by the reading only
  const sure = classes.length === 0 ? r.confidence >= 0.85 : p >= MIN_PROB;
  return { ok: agrees(m.char, r.text) && sure, read: r.text, p: Math.round(p * 100) / 100 };
}

export interface ExtractResult {
  glyphs: Glyph[];
  places: CharPlace[];
}

export async function extractLine(
  la: LineAnalysis,
  text: string,
  ocr: CtcRecognizer | undefined,
  opts: { file: string; pxPerMm: number | null; widths?: Map<string, number>; verify?: boolean; onProgress?: (done: number, total: number) => void },
): Promise<ExtractResult> {
  const al = alignText({
    text, primitives: la.seg.primitives, boundaries: la.seg.boundaries, xh: la.strip.xh, sw: la.strip.sw,
    frames: la.frames, classOf: ocr ? (c) => ocr.classOf(c) : undefined, widths: opts.widths,
  });
  const raw = extractGlyphs(la, al.places, { file: opts.file, pxPerMm: opts.pxPerMm });
  const glyphs = raw.map(normalizeGlyph);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const m = g.meta;
    // shape sanity that needs no recogniser: a letter far wider or narrower than expected is not taken automatically
    const w = (m.bbox[2] - m.bbox[0]) / m.x_height;
    let auto = m.quality.auto && w > 0.08 && w < 3.2;
    if (ocr && opts.verify !== false) {
      const v = await verifyGlyph(g, ocr);
      m.quality.read = v.read;
      m.quality.p = v.p;
      auto = auto && v.ok;
    } else if (isJoining(m.char)) auto = auto && m.quality.cost < 2.2;
    m.quality.auto = auto;
    opts.onProgress?.(i + 1, glyphs.length);
  }
  return { glyphs, places: al.places };
}
