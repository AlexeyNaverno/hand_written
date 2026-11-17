/** Synthetic "handwriting" for tests: simple pen-drawn shapes with known geometry. */
import type { Glyph, GlyphMeta, Joint } from '../src/core/library';

interface Shape { pts: [number, number][]; }

/** Draws polylines with a round pen into a straight-alpha RGBA image. Coordinates: x right, y down, baseline at `base`. */
export function drawGlyph(char: string, shapes: Shape[], w: number, h: number, base: number, xh: number, pen = 5, id = char): Glyph {
  const rgba = new Uint8Array(w * h * 4);
  const stamp = (cx: number, cy: number) => {
    const r = pen / 2;
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(h - 1, Math.ceil(cy + r + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(w - 1, Math.ceil(cx + r + 1)); x++) {
        const d = Math.hypot(x - cx, y - cy);
        const a = Math.max(0, Math.min(1, r + 0.5 - d));
        const t = 4 * (y * w + x);
        if (a * 255 > rgba[t + 3]) { rgba[t] = 30; rgba[t + 1] = 40; rgba[t + 2] = 130; rgba[t + 3] = Math.round(a * 255); }
      }
    }
  };
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const s of shapes) {
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const [ax, ay] = s.pts[i];
      const [bx, by] = s.pts[i + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
      for (let k = 0; k <= n; k++) stamp(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    }
    for (const [x, y] of s.pts) { x0 = Math.min(x0, x - pen / 2); x1 = Math.max(x1, x + pen / 2); y0 = Math.min(y0, y - pen / 2); y1 = Math.max(y1, y + pen / 2); }
  }
  const first = shapes[0].pts;
  const last = shapes[shapes.length - 1].pts;
  const cyr = /[а-яё]/i.test(char);
  const joint = (p0: [number, number], p1: [number, number]): Joint => ({ kind: 'cut', level: 'low', p0, p1, width: pen, conf: 1 });
  const meta: GlyphMeta = {
    schema: 2, id, char, variant: 1, position: 'medial', prev: '', next: '', width: w, height: h,
    bbox: [x0, y0, x1, y1], baseline: base, x_height: xh, stroke_width: pen, slant: 0, ink_rgb: [30, 40, 130],
    entry: cyr ? joint(first[0], first[1]) : null,
    exit: cyr ? joint(last[last.length - 1], last[last.length - 2]) : null,
    source: { file: 'test', line: 0, index: 0, px_per_mm: null }, quality: { cost: 0, auto: true }, enabled: true, checked_by_user: true,
  };
  return { meta, rgba };
}

/** A tiny alphabet: every letter is a hook between the baseline and the x-line, some with a stem above or below. */
export function tinyLibrary(xh = 40): Glyph[] {
  const b = 70;
  const hook = (w: number): [number, number][] => [[4, b - 0.15 * xh], [4 + 0.3 * w, b - xh], [4 + 0.45 * w, b - 0.1 * xh], [4 + 0.6 * w, b], [4 + w, b - 0.45 * xh]];
  const mk = (ch: string, w: number, extra: Shape[] = []) => drawGlyph(ch, [{ pts: hook(w) }, ...extra].slice(0, 1).concat(extra.length ? [] : []), Math.ceil(w + 12), 120, b, xh);
  const withStem = (ch: string, w: number, up: boolean) => {
    const pts = hook(w);
    const stem: [number, number][] = up ? [[4 + 0.3 * w, b - xh], [4 + 0.3 * w, b - 1.7 * xh]] : [[4 + 0.6 * w, b], [4 + 0.5 * w, b + 0.9 * xh]];
    const g = drawGlyph(ch, [{ pts: [...pts.slice(0, up ? 2 : 4), ...stem, ...stem.slice().reverse(), ...pts.slice(up ? 1 : 3)] }], Math.ceil(w + 12), 120, b, xh);
    return g;
  };
  return [
    mk('а', 30), mk('о', 28), mk('и', 34), mk('м', 46), mk('т', 44), mk('е', 26),
    withStem('в', 30, true), withStem('б', 30, true), withStem('р', 30, false), withStem('у', 32, false),
    drawGlyph('.', [{ pts: [[5, b - 2], [6, b - 2]] }], 12, 120, b, xh),
    drawGlyph('1', [{ pts: [[6, b - 1.5 * xh], [6, b]] }], 14, 120, b, xh),
  ];
}
