import { beforeAll, describe, expect, it } from 'vitest';
import { alignText } from '../src/core/analyze/align';
import { analyzePage } from '../src/core/analyze/page';
import { extractStrip } from '../src/core/analyze/strip';
import type { Boundary, Primitive } from '../src/core/analyze/segment';
import { fileStem, parseStem } from '../src/core/charset';
import { loadCV } from '../src/core/cv';
import { agrees, shapeAgrees } from '../src/core/harvest';
import { ransacLine, thin } from '../src/core/imgops';
import { upgradeLegacy } from '../src/core/library';
import { PdfWriter } from '../src/core/pdf';
import { decodePng, encodePng } from '../src/core/png';
import { layoutText, parseParagraphs, renderLine } from '../src/core/synth/engine';
import { DEFAULT_OPTIONS } from '../src/core/synth/options';
import { drawGlyph, tinyLibrary } from './helpers';

beforeAll(async () => {
  await loadCV();
});

describe('file names', () => {
  it('round-trips new names', () => {
    for (const [ch, v] of [['а', 3], ['Б', 2], ['.', 1], ['=', 4], ['7', 2], ['q', 1], ['Q', 5]] as [string, number][]) {
      expect(parseStem(fileStem(ch, v))).toEqual({ char: ch, variant: v });
    }
  });
  it('reads names of the old desktop program', () => {
    expect(parseStem('а3')).toEqual({ char: 'а', variant: 3 });
    expect(parseStem('загл_б2')).toEqual({ char: 'Б', variant: 2 });
    expect(parseStem('точка')).toEqual({ char: '.', variant: 1 });
    expect(parseStem('точка_с_запятой2')).toEqual({ char: ';', variant: 2 });
    expect(parseStem('01')).toEqual({ char: '0', variant: 1 });
  });
  it('upgrades the old JSON', () => {
    const m = upgradeLegacy({ baseline: 105.0, bbox: [33.5, 34.5, 80.5, 102.5] }, 'а', 1, 120, 140);
    expect(m.baseline).toBe(105);
    expect(m.bbox).toEqual([33.5, 34.5, 80.5, 102.5]);
    expect(m.x_height).toBeGreaterThan(50);
    expect(m.entry).toBeNull();
  });
});

describe('png and pdf', () => {
  it('png survives a round trip', () => {
    const w = 37, h = 21;
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 31 + (i >> 3)) & 0xff);
    const back = decodePng(encodePng(rgba, w, h));
    expect(back.width).toBe(w);
    expect(Array.from(back.rgba)).toEqual(Array.from(rgba));
  });
  it('pdf cross-reference table points at the objects', () => {
    const pdf = new PdfWriter(148, 210);
    const rgba = new Uint8Array(10 * 6 * 4).fill(200);
    pdf.addPage([{ rgba, width: 10, height: 6, xMm: 10, yMm: 20, wMm: 30, hMm: 18 }], [{ x1: 0, y1: 5, x2: 148, y2: 5, rgb: [1, 2, 3], widthMm: 0.1 }]);
    pdf.addPage([]);
    const parts = pdf.finish();
    const all = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const text = all.toString('latin1');
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const rows = text.slice(xref).split('\n').slice(2).filter((r) => / n $/.test(r));
    rows.forEach((r, i) => expect(text.slice(Number(r.slice(0, 10))).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(text).toContain('/Count 2');
    expect(text).toContain('/SMask');
  });
});

describe('geometry', () => {
  it('robust line ignores descender outliers', () => {
    const xs: number[] = [], ys: number[] = [];
    for (let x = 0; x < 300; x += 10) { xs.push(x); ys.push(100 + 0.01 * x + (x % 70 === 0 ? 25 : 0)); }
    const fit = ransacLine(xs, ys, 2, 0.05);
    expect(fit.a).toBeCloseTo(0.01, 2);
    expect(fit.c).toBeCloseTo(100, 0);
  });
  it('thinning keeps a one-pixel line through a thick stroke', () => {
    const w = 40, h = 20, img = new Uint8Array(w * h);
    for (let y = 7; y < 13; y++) for (let x = 3; x < 37; x++) img[y * w + x] = 1;
    const sk = thin(img, w, h);
    const perCol = Array.from({ length: w }, (_, x) => { let c = 0; for (let y = 0; y < h; y++) c += sk[y * w + x]; return c; });
    expect(Math.max(...perCol.slice(8, 32))).toBe(1);
  });
});

describe('alignment', () => {
  const prim = (xa: number, xb: number, top: number, bottom: number, left: number, right: number): Primitive => ({ xa, xb, top, bottom, width: (xb - xa + 1) / 40, mass: (xb - xa) * 12, left, right });
  it('gives a wide letter two pieces and respects the word gap', () => {
    // "ми а": м = two hooks, и = one, then a gap, then а
    const boundaries: Boundary[] = [
      { kind: 'gap', xd: 0, gap: Infinity, px: 0, py: 0 }, { kind: 'cut', xd: 30, gap: 0, px: 30, py: 0 }, { kind: 'cut', xd: 60, gap: 0, px: 60, py: 0 },
      { kind: 'gap', xd: 110, gap: 40, px: 110, py: 0 }, { kind: 'gap', xd: 170, gap: Infinity, px: 170, py: 0 },
    ];
    const primitives = [prim(0, 29, 1, 0, 0, 1), prim(30, 59, 1, 0, 1, 2), prim(60, 95, 1, 0, 2, 3), prim(136, 168, 1, 0, 3, 4)];
    const al = alignText({ text: 'ми а', primitives, boundaries, xh: 40, sw: 5 });
    const got = al.places.map((p) => `${p.ch}:${p.p0}-${p.p1}`);
    expect(got).toEqual(['м:0-2', 'и:2-3', ' :-1--1', 'а:3-4']);
  });
});

describe('recognition check of a single letter', () => {
  it('accepts look-alikes and rejects extra characters', () => {
    expect(agrees('о', '0')).toBe(true);
    expect(agrees('с', 'С')).toBe(true);
    expect(agrees('а', 'а.')).toBe(false);
    expect(agrees('е', 'ле')).toBe(false);
    expect(agrees('.', '.')).toBe(true);
  });
});

describe('simple signs are checked by shape', () => {
  const b = 70, xh = 40;
  it('equals sign needs two stacked strokes', () => {
    const two = drawGlyph('=', [{ pts: [[6, b - 26], [34, b - 30]] }, { pts: [[6, b - 14], [34, b - 18]] }], 44, 100, b, xh, 4);
    const one = drawGlyph('=', [{ pts: [[6, b - 20], [34, b - 22]] }], 44, 100, b, xh, 4);
    expect(shapeAgrees(two)).toBe(true);
    expect(shapeAgrees(one)).toBe(false);
  });
  it('full stop sits on the line, comma hangs below it, a letter is not judged', () => {
    expect(shapeAgrees(drawGlyph('.', [{ pts: [[6, b - 2], [7, b - 2]] }], 14, 100, b, xh, 5))).toBe(true);
    expect(shapeAgrees(drawGlyph('.', [{ pts: [[6, b - 30], [7, b - 30]] }], 14, 100, b, xh, 5))).toBe(false);
    expect(shapeAgrees(drawGlyph(',', [{ pts: [[9, b - 2], [5, b + 9]] }], 16, 100, b, xh, 4))).toBe(true);
    expect(shapeAgrees(tinyLibrary()[0])).toBeUndefined();
  });
});

describe('text layout', () => {
  it('finds headings by the rule and by explicit marks', () => {
    const ps = parseParagraphs('Итоги\nтри слова тут.\nа это уже обычный длинный абзац текста\n**Явный заголовок из многих слов подряд**', DEFAULT_OPTIONS);
    expect(ps.map((p) => p.kind)).toEqual(['heading', 'text', 'text', 'heading']);
  });
  it('lays out, reports missing letters and renders a line with transparency', () => {
    const lib = tinyLibrary();
    const lay = layoutText('томат\nмама мыла раму. а море и мир о том', lib, { dpi: 200, seed: 3 });
    expect(lay.missing.sort()).toEqual(['л', 'ы']);
    const [head, first] = lay.pages[0].lines;
    const ppm = 200 / 25.4;
    // the heading is centred between the margins of the first (odd) page
    const xs = head.words.flatMap((w) => [w.x0, w.x1]);
    const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
    const expected = ((DEFAULT_OPTIONS.marginLeftMm + DEFAULT_OPTIONS.bindingMm) + (DEFAULT_OPTIONS.pageWmm - DEFAULT_OPTIONS.marginRightMm)) / 2 * ppm;
    expect(Math.abs(centre - expected)).toBeLessThan(2);
    expect(first.baselineY - head.baselineY).toBeCloseTo(DEFAULT_OPTIONS.rowMm * ppm, 3);
    expect(first.strokes.length).toBeGreaterThan(3);
    const r = renderLine(first, { dpi: 200 })!;
    let opaque = 0, clear = 0;
    for (let i = 3; i < r.rgba.length; i += 4) { if (r.rgba[i] > 200) opaque++; else if (r.rgba[i] === 0) clear++; }
    expect(opaque).toBeGreaterThan(200);
    expect(clear).toBeGreaterThan(opaque);
  });
  it('a short paragraph that does not fit into one line is not a heading', () => {
    const lib = tinyLibrary();
    const long = 'томатомато мамамамама атаматама мематома';
    const lay = layoutText(long, lib, { dpi: 200, xHeightMm: 4.5 });
    expect(lay.pages[0].lines.length).toBeGreaterThan(1);
    const first = lay.pages[0].lines[0];
    const ppm = 200 / 25.4;
    // written as ordinary text: starts at the paragraph indent instead of being centred
    const left = (DEFAULT_OPTIONS.marginLeftMm + DEFAULT_OPTIONS.bindingMm + DEFAULT_OPTIONS.indentMm) * ppm;
    expect(Math.abs(first.words[0].x0 - left)).toBeLessThan(0.8 * ppm);
  });
  it('is reproducible for the same seed and differs for another', () => {
    const lib = tinyLibrary();
    const a = layoutText('мама и папа', lib, { seed: 5 }).pages[0].lines[0].placed.map((p) => Math.round(p.x));
    const b = layoutText('мама и папа', lib, { seed: 5 }).pages[0].lines[0].placed.map((p) => Math.round(p.x));
    const c = layoutText('мама и папа', lib, { seed: 6 }).pages[0].lines[0].placed.map((p) => Math.round(p.x));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

/** Renders a synthetic page: known baselines, optional notebook ruling drawn in a pale colour. */
function syntheticPage(paper: 'blank' | 'squared' | 'ruled', jitter = 0) {
  const lib = tinyLibrary();
  const dpi = 200;
  const text = 'мама и тома в море у бара\nбарет и рубеж томата в ароме\nбум марта и море ветра у борта\nвремя мира о том у утра';
  const opts = { dpi, seed: 11, jitter, rowMm: 10, xHeightMm: 3, headingMaxWords: 0, indentMm: 0, bindingMm: 0 };
  const lay = layoutText(text, lib, opts);
  const ppm = dpi / 25.4;
  const W = Math.round(DEFAULT_OPTIONS.pageWmm * ppm), H = Math.round(70 * ppm);
  const page = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { page[4 * i] = 246; page[4 * i + 1] = 244; page[4 * i + 2] = 238; page[4 * i + 3] = 255; }
  const rule = (x: number, y: number) => { const t = 4 * (y * W + x); page[t] = 176; page[t + 1] = 200; page[t + 2] = 226; };
  if (paper !== 'blank') {
    // lines every 5 mm (squares) or every 10 mm (ruled); text baselines fall on them
    for (let k = 1; k * 5 * ppm < H; k++) { if (paper === 'ruled' && k % 2 === 0) continue; const y = Math.round(k * 5 * ppm); for (let x = 0; x < W; x++) rule(x, y); }
    if (paper === 'squared') for (let k = 1; k * 5 * ppm < W; k++) { const x = Math.round(k * 5 * ppm); for (let y = 0; y < H; y++) rule(x, y); }
  }
  for (const ln of lay.pages[0].lines) {
    const r = renderLine(ln, opts)!;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const s2 = 4 * (y * r.width + x), a = r.rgba[s2 + 3] / 255, t = 4 * ((r.y + y) * W + r.x + x);
      if (!a || r.y + y >= H) continue;
      for (let c = 0; c < 3; c++) page[t + c] = Math.round(r.rgba[s2 + c] * a + page[t + c] * (1 - a));
    }
  }
  return { img: { width: W, height: H, data: page }, truth: lay.pages[0].lines.map((l) => l.baselineY), xh: 3 * ppm, ppm, W };
}

describe('notebook paper (synthetic pages with pale ruling)', () => {
  for (const paper of ['squared', 'ruled'] as const) {
    it(`${paper}: the ruling is recognised, erased and does not disturb the baselines`, () => {
      const { img, truth, xh, ppm, W } = syntheticPage(paper, 0.5);
      const pa = analyzePage(img);
      expect(pa.ruling).not.toBeNull();
      expect(pa.ruling!.squared).toBe(paper === 'squared');
      if (paper === 'squared') expect(Math.abs(pa.pxPerMm! - ppm) / ppm).toBeLessThan(0.05);
      expect(pa.lines.length).toBe(truth.length);
      pa.lines.forEach((l, i) => expect(Math.abs(l.a * (W / 2) + l.c - truth[i]) / xh).toBeLessThan(0.15));
      // inside a line strip no printed line may survive as ink: it would glue the letters together
      const st = extractStrip(img, pa, pa.lines[1]);
      let longest = 0;
      for (let y = 0; y < st.height; y++) { let run = 0; for (let x = 0; x < st.width; x++) { if (st.ink[y * st.width + x]) { run++; longest = Math.max(longest, run); } else run = 0; } }
      expect(longest).toBeLessThan(1.5 * st.xh);
      let tallest = 0;
      for (let x = 0; x < st.width; x++) { let run = 0; for (let y = 0; y < st.height; y++) { if (st.ink[y * st.width + x]) { run++; tallest = Math.max(tallest, run); } else run = 0; } }
      expect(tallest).toBeLessThan(3.2 * st.xh);
    });
  }
});

describe('baseline of an ordinary page (synthetic page with known baselines)', () => {
  it('finds every line within a small fraction of the letter height', () => {
    const lib = tinyLibrary();
    const dpi = 200;
    const text = 'мама и тома в море у бара\nбарет и рубеж томата в ароме\nбум марта и море ветра у борта\nвремя мира о том у утра';
    const opts = { dpi, seed: 11, jitter: 0, rowMm: 10, xHeightMm: 3, headingMaxWords: 0, indentMm: 0, bindingMm: 0 };
    const lay = layoutText(text, lib, opts);
    const ppm = dpi / 25.4;
    const W = Math.round(DEFAULT_OPTIONS.pageWmm * ppm), H = Math.round(60 * ppm);
    const page = new Uint8Array(W * H * 4).fill(255);
    for (const ln of lay.pages[0].lines) {
      const r = renderLine(ln, opts)!;
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
        const s = 4 * (y * r.width + x), a = r.rgba[s + 3] / 255, t = 4 * ((r.y + y) * W + r.x + x);
        if (!a || r.y + y >= H) continue;
        for (let c = 0; c < 3; c++) page[t + c] = Math.round(r.rgba[s + c] * a + page[t + c] * (1 - a));
      }
    }
    const pa = analyzePage({ width: W, height: H, data: page });
    const truth = lay.pages[0].lines.map((l) => l.baselineY);
    expect(pa.lines.length).toBe(truth.length);
    const xh = 3 * ppm;
    pa.lines.forEach((l, i) => {
      const y = l.a * (W / 2) + l.c;
      expect(Math.abs(y - truth[i]) / xh).toBeLessThan(0.1);
      expect(Math.abs(l.xHeight - xh) / xh).toBeLessThan(0.25);
    });
  });
});
