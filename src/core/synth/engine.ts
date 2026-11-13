/**
 * Text → pages of handwritten lines.
 * Letters are the writer's own images; joined letters are connected by a pen stroke drawn along a curve
 * (with a small artificial bump, so that the connection does not look machine-made).
 * Every line is rendered separately into a transparent raster, which keeps memory small on a phone.
 */
import * as cv from '../cv';
import { entryLevel, exitLevel, isJoining, isUpper } from '../charset';
import { Glyph, Position } from '../library';
import { Rng, clamp } from '../types';
import { DEFAULT_OPTIONS, SynthOptions } from './options';

export { DEFAULT_OPTIONS };
export type { SynthOptions };

const CLOSING = '.,;:!?)»…”';
const OPENING = '(«“„';
const OPERATORS = '=+−-×*/<>';
const SUBSTITUTES: Record<string, string> = {
  'ё': 'е', 'Ё': 'Е', '—': '-', '–': '-', '−': '-', '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', '’': "'", '×': '*', '…': '.',
};

interface Pick {
  glyph: Glyph;
  /** Enlargement for a lowercase letter standing in for a missing capital. */
  boost: number;
}

/** Chooses letter variants: prefers the same place in the word and the same kind of neighbours as in the source. */
export class GlyphIndex {
  private byChar = new Map<string, Glyph[]>();
  private recent = new Map<string, string[]>();
  constructor(glyphs: Glyph[]) {
    for (const g of glyphs) {
      if (!g.meta.enabled) continue;
      const list = this.byChar.get(g.meta.char) ?? [];
      list.push(g);
      this.byChar.set(g.meta.char, list);
    }
  }
  has(ch: string): boolean {
    return this.byChar.has(ch);
  }
  chars(): string[] {
    return [...this.byChar.keys()];
  }
  private candidates(ch: string): Pick[] | null {
    const direct = this.byChar.get(ch);
    if (direct) return direct.map((glyph) => ({ glyph, boost: 1 }));
    const sub = SUBSTITUTES[ch];
    if (sub && this.byChar.get(sub)) return this.byChar.get(sub)!.map((glyph) => ({ glyph, boost: 1 }));
    if (isUpper(ch) && this.byChar.get(ch.toLowerCase())) return this.byChar.get(ch.toLowerCase())!.map((glyph) => ({ glyph, boost: 1.45 }));
    if (ch !== ch.toUpperCase() && this.byChar.get(ch.toUpperCase())) return this.byChar.get(ch.toUpperCase())!.map((glyph) => ({ glyph, boost: 0.7 }));
    return null;
  }
  pick(ch: string, position: Position, prev: string, next: string, rng: Rng): Pick | null {
    const cands = this.candidates(ch);
    if (!cands) return null;
    const recent = this.recent.get(ch) ?? [];
    const scored = cands.map((c) => {
      const m = c.glyph.meta;
      let s = 0;
      if (m.position === position) s += 3;
      else if ((m.position === 'medial') !== (position === 'medial')) s -= 0.5;
      if (next && m.next && isJoining(next) && isJoining(m.next) && entryLevel(next) === entryLevel(m.next)) s += 1.2;
      if (prev && m.prev && isJoining(prev) && isJoining(m.prev) && exitLevel(prev) === exitLevel(m.prev)) s += 1.2;
      if (next && isJoining(next) && m.exit?.kind === 'cut') s += 1;
      if (prev && isJoining(prev) && m.entry?.kind === 'cut') s += 1;
      if (m.checked_by_user) s += 1;
      s -= 0.3 * Math.min(6, m.quality.cost);
      const age = recent.lastIndexOf(m.id);
      if (age >= 0) s -= 2.5 / (recent.length - age);
      return { c, s: s + rng.range(0, 0.8) };
    });
    scored.sort((a, b) => b.s - a.s);
    const chosen = scored[0].c;
    recent.push(chosen.glyph.meta.id);
    if (recent.length > 4) recent.shift();
    this.recent.set(ch, recent);
    return chosen;
  }
}

interface Placed {
  g: Glyph;
  /** Page pixel position of the glyph image origin and its scale. */
  x: number;
  y: number;
  sx: number;
  sy: number;
}

interface Stroke {
  /** x, y, width triples in page pixels. */
  pts: Float32Array;
  rgb: [number, number, number];
  alpha: number;
  soft: number;
}

interface WordLayout {
  placed: Placed[];
  strokes: Stroke[];
  width: number;
}

export interface LineLayout {
  placed: Placed[];
  strokes: Stroke[];
  pressure: number;
  baselineY: number;
  text: string;
  /** Words of the line with their horizontal extent in page pixels (used to check the result by recognition). */
  words: { text: string; x0: number; x1: number }[];
}

export interface PageLayout {
  lines: LineLayout[];
  leftMm: number;
}

export interface Layout {
  pages: PageLayout[];
  /** Characters of the text for which the library has no glyph. */
  missing: string[];
}

function edgeWidth(g: Glyph): number {
  let partial = 0;
  let solid = 0;
  const d = g.rgba;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] >= 128) solid++;
    if (d[i] > 38 && d[i] < 217) partial++;
  }
  const length = solid / Math.max(1, g.meta.stroke_width);
  return clamp(partial / Math.max(1, 2 * length), 0.6, 6);
}

function connector(
  a: { x: number; y: number; dx: number; dy: number; w: number; rgb: [number, number, number]; soft: number },
  b: { x: number; y: number; dx: number; dy: number; w: number; rgb: [number, number, number]; soft: number },
  xh: number,
  opts: SynthOptions,
  pressure: number,
  rng: Rng,
): Stroke | null {
  const D = Math.hypot(b.x - a.x, b.y - a.y);
  if (D < 1.2) return null;
  const k1 = rng.range(0.3, 0.46) * D;
  const k2 = rng.range(0.3, 0.46) * D;
  const c1x = a.x + a.dx * k1, c1y = a.y + a.dy * k1;
  const c2x = b.x - b.dx * k2, c2y = b.y - b.dy * k2;
  // artificial bump: a short hump across the stroke, mostly upwards, at a random place
  const amp = opts.bump * xh * rng.range(0.03, 0.085) * Math.min(1, D / (0.5 * xh)) * (rng.next() < 0.7 ? -1 : 1);
  const t0 = rng.range(0.35, 0.65);
  const sigma = rng.range(0.13, 0.2);
  const n = Math.max(8, Math.ceil(D * 1.5));
  const pts = new Float32Array((n + 1) * 3);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x;
    const y = u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b.y;
    // tangent → normal
    const tx = 3 * u * u * (c1x - a.x) + 6 * u * t * (c2x - c1x) + 3 * t * t * (b.x - c2x);
    const ty = 3 * u * u * (c1y - a.y) + 6 * u * t * (c2y - c1y) + 3 * t * t * (b.y - c2y);
    const tl = Math.hypot(tx, ty) || 1;
    const bumpV = amp * Math.exp(-((t - t0) * (t - t0)) / (sigma * sigma));
    pts[3 * i] = x + (-ty / tl) * bumpV * (tx >= 0 ? 1 : -1);
    pts[3 * i + 1] = y + (tx / tl) * bumpV * (tx >= 0 ? 1 : -1);
    // connecting strokes are lighter in the middle
    pts[3 * i + 2] = Math.max(0.8, (a.w + (b.w - a.w) * t) * (1 - 0.22 * Math.sin(Math.PI * t)) * pressure);
  }
  const rgb: [number, number, number] = [Math.round((a.rgb[0] + b.rgb[0]) / 2), Math.round((a.rgb[1] + b.rgb[1]) / 2), Math.round((a.rgb[2] + b.rgb[2]) / 2)];
  return { pts, rgb, alpha: rng.range(0.86, 0.96), soft: 0.5 * (a.soft + b.soft) };
}

class Composer {
  missing = new Set<string>();
  readonly xh: number;
  readonly ppm: number;
  constructor(private index: GlyphIndex, private opts: SynthOptions, private rng: Rng) {
    this.ppm = opts.dpi / 25.4;
    this.xh = opts.xHeightMm * this.ppm;
  }

  /** Lays out one word with its origin at (0, 0): x grows right, the baseline is y = 0. */
  word(text: string, pressure: number): WordLayout {
    const { xh, rng, opts } = this;
    const chars = [...text];
    const placed: Placed[] = [];
    const strokes: Stroke[] = [];
    let right = 0;
    let prevLeft = -Infinity;
    let prevExit: { x: number; y: number; dx: number; dy: number; w: number; rgb: [number, number, number]; soft: number } | null = null;
    let prevCh = '';
    chars.forEach((ch, i) => {
      const before = i > 0 ? chars[i - 1] : '';
      const after = i + 1 < chars.length ? chars[i + 1] : '';
      const pj = !!before && isJoining(before);
      const nj = !!after && isJoining(after);
      const position: Position = !isJoining(ch) ? 'isolated' : pj && nj ? 'medial' : nj ? 'initial' : pj ? 'final' : 'isolated';
      const pk = this.index.pick(ch, position, before, after, rng);
      if (!pk) {
        this.missing.add(ch);
        right += 0.7 * xh;
        prevExit = null;
        prevCh = ch;
        return;
      }
      const m = pk.glyph.meta;
      const sizeStep = Math.round(rng.gauss(0, 1.2 * opts.jitter)); // a few discrete sizes keep the scaled-glyph cache useful
      const s = (xh / m.x_height) * pk.boost * (1 + 0.02 * clamp(sizeStep, -2, 2));
      const gy = -m.baseline * s + rng.gauss(0, 0.02 * xh * opts.jitter);
      const soft = edgeWidth(pk.glyph) * s;
      let gx: number;
      let joined = false;
      const first = placed.length === 0 && right === 0;
      if (first) gx = -m.bbox[0] * s;
      else if (prevExit && m.entry && isJoining(ch) && isJoining(prevCh)) {
        const gap = xh * rng.range(0.05, 0.16);
        gx = prevExit.x + gap - m.entry.p0[0] * s;
        const left = gx + m.bbox[0] * s;
        // the joints of a badly measured glyph may ask for an absurd overlap or gap: then fall back to spacing by boxes
        if (left < prevLeft + 0.18 * xh || left > right + 0.7 * xh) gx = right + 0.1 * xh - m.bbox[0] * s;
        else joined = true;
      } else {
        let bearing = xh * rng.range(0.1, 0.18);
        if (CLOSING.includes(ch) || OPENING.includes(prevCh)) bearing = xh * 0.05;
        if (OPERATORS.includes(ch) || OPERATORS.includes(prevCh)) bearing = xh * rng.range(0.24, 0.32);
        gx = right + bearing - m.bbox[0] * s;
      }
      if (joined && prevExit && m.entry) {
        const e = m.entry;
        const dl = Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1]) || 1;
        const st = connector(prevExit, {
          x: gx + e.p0[0] * s, y: gy + e.p0[1] * s, dx: (e.p1[0] - e.p0[0]) / dl, dy: (e.p1[1] - e.p0[1]) / dl,
          w: e.width * s, rgb: opts.inkColor ?? m.ink_rgb, soft,
        }, xh, opts, pressure, rng);
        if (st) strokes.push(st);
      }
      placed.push({ g: pk.glyph, x: gx, y: gy, sx: s, sy: s });
      prevLeft = gx + m.bbox[0] * s;
      right = Math.max(right, gx + m.bbox[2] * s);
      if (m.exit && isJoining(ch)) {
        const x = m.exit;
        const dl = Math.hypot(x.p0[0] - x.p1[0], x.p0[1] - x.p1[1]) || 1;
        prevExit = { x: gx + x.p0[0] * s, y: gy + x.p0[1] * s, dx: (x.p0[0] - x.p1[0]) / dl, dy: (x.p0[1] - x.p1[1]) / dl, w: x.width * s, rgb: opts.inkColor ?? m.ink_rgb, soft };
      } else prevExit = null;
      prevCh = ch;
    });
    return { placed, strokes, width: right };
  }
}

interface Paragraph {
  kind: 'text' | 'heading' | 'subheading' | 'blank';
  words: string[];
}

export function parseParagraphs(text: string, opts: SynthOptions): Paragraph[] {
  const out: Paragraph[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine.trim();
    if (!line) { out.push({ kind: 'blank', words: [] }); continue; }
    let kind: Paragraph['kind'] = 'text';
    // explicit marks of the old program: **heading**, *subheading*
    if (/^\*\*.+\*\*$/.test(line)) { kind = 'heading'; line = line.slice(2, -2).trim(); }
    else if (/^\*.+\*$/.test(line)) { kind = 'subheading'; line = line.slice(1, -1).trim(); }
    const words = line.split(/\s+/).filter(Boolean);
    if (kind === 'text' && words.length < opts.headingMaxWords && !(opts.headingNoTrailingDot && /[.,;:…]$/.test(line))) kind = 'heading';
    out.push({ kind, words });
  }
  // blank lines at the ends carry no meaning
  while (out.length && out[0].kind === 'blank') out.shift();
  while (out.length && out[out.length - 1].kind === 'blank') out.pop();
  return out;
}

export function layoutText(text: string, glyphs: Glyph[], options: Partial<SynthOptions> = {}): Layout {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rng = new Rng(opts.seed);
  const index = new GlyphIndex(glyphs);
  const comp = new Composer(index, opts, rng);
  const ppm = comp.ppm;
  const xh = comp.xh;
  const row = opts.rowMm * ppm;
  const pageH = opts.pageHmm * ppm;
  const rowsPerPage = Math.max(1, Math.floor((pageH - (opts.marginTopMm + opts.marginBottomMm) * ppm) / row));
  const pages: PageLayout[] = [];
  let rowIdx = rowsPerPage; // forces the first page
  let page: PageLayout | null = null;
  let left = 0;
  let contentW = 0;
  const newPage = () => {
    const odd = pages.length % 2 === 0;
    const leftMm = opts.marginLeftMm + (odd ? opts.bindingMm : 0);
    const rightMm = opts.marginRightMm + (odd ? 0 : opts.bindingMm);
    left = leftMm * ppm;
    contentW = (opts.pageWmm - leftMm - rightMm) * ppm;
    page = { lines: [], leftMm };
    pages.push(page);
    rowIdx = 0;
  };
  const nextRow = () => {
    if (rowIdx >= rowsPerPage) newPage();
    const y = opts.marginTopMm * ppm + (rowIdx + 1) * row;
    rowIdx++;
    return y;
  };
  const emit = (items: { wl: WordLayout; x: number; text: string }[], kind: Paragraph['kind'], used: number, pressure: number, text: string) => {
    const baselineY = nextRow();
    const j = opts.jitter;
    let shift = rng.gauss(0, 0.4 * ppm * j);
    if (kind === 'heading') shift = (contentW - used) / 2;
    const slope = rng.gauss(0, 0.0022 * j);
    const amp = rng.range(0.04, 0.12) * xh * j;
    const lambda = rng.range(55, 95) * ppm;
    const phase = rng.range(0, 6.28);
    const line: LineLayout = { placed: [], strokes: [], pressure, baselineY, text, words: [] };
    for (const it of items) {
      const wx = left + shift + it.x;
      line.words.push({ text: it.text, x0: wx, x1: wx + it.wl.width });
      const wy = baselineY + slope * (wx - left) + amp * Math.sin((2 * Math.PI * wx) / lambda + phase);
      for (const p of it.wl.placed) line.placed.push({ ...p, x: p.x + wx, y: p.y + wy });
      for (const s of it.wl.strokes) {
        const pts = new Float32Array(s.pts);
        for (let i = 0; i < pts.length; i += 3) { pts[i] += wx; pts[i + 1] += wy; }
        line.strokes.push({ ...s, pts });
      }
    }
    page!.lines.push(line);
  };

  for (const para of parseParagraphs(text, opts)) {
    if (para.kind === 'blank') { nextRow(); continue; }
    // pen thickness changes only between paragraphs; headings are usually written with a firmer hand
    const pressure = para.kind === 'text' ? 1 + opts.pressureVar * rng.range(-0.12, 0.12) : 1 + opts.pressureVar * rng.range(0.03, 0.14);
    let indent = para.kind === 'text' ? opts.indentMm * ppm : para.kind === 'subheading' ? 2 * opts.indentMm * ppm : 0;
    let items: { wl: WordLayout; x: number; text: string }[] = [];
    let x = indent;
    let lineText = '';
    for (const w of para.words) {
      const wl = comp.word(w, pressure);
      const space = items.length ? opts.wordSpace * xh * rng.range(0.85, 1.2) : 0;
      if (items.length && x + space + wl.width > contentW) {
        emit(items, para.kind, x, pressure, lineText);
        items = [];
        x = 0;
        indent = 0;
        lineText = '';
      }
      const sp = items.length ? space : 0;
      // a word slightly too long for the line is squeezed, as a writer does near the margin
      const over = (x + sp + wl.width) / contentW;
      if (!items.length && over > 1 && over < 1.25) {
        const f = Math.max(0.8, 1 / over);
        for (const p of wl.placed) { p.x *= f; p.sx *= f; }
        for (const s of wl.strokes) for (let i = 0; i < s.pts.length; i += 3) s.pts[i] *= f;
        wl.width *= f;
      }
      items.push({ wl, x: x + sp, text: w });
      x += sp + wl.width;
      lineText += (lineText ? ' ' : '') + w;
    }
    if (items.length) emit(items, para.kind, x, pressure, lineText);
  }
  if (!pages.length) newPage();
  return { pages, missing: [...comp.missing] };
}

// ---------------------------------------------------------------- rendering

/** Glyph image with the pen pressure applied: the stroke edge moves in or out by a fraction of the stroke width. */
function pressed(g: Glyph, pressure: number, ink: [number, number, number] | null): Uint8Array {
  const m = g.meta;
  const n = m.width * m.height;
  const src = g.rgba;
  const out = new Uint8Array(src);
  const rgb = ink ?? m.ink_rgb;
  if (ink) for (let i = 0; i < n; i++) { out[4 * i] = ink[0]; out[4 * i + 1] = ink[1]; out[4 * i + 2] = ink[2]; }
  const delta = (pressure - 1) * 0.5 * m.stroke_width;
  if (Math.abs(delta) < 0.08) return out;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  let solidSum = 0;
  let solidN = 0;
  for (let i = 0; i < n; i++) {
    const a = src[4 * i + 3];
    inside[i] = a >= 128 ? 1 : 0;
    outside[i] = 1 - inside[i];
    if (a >= 200) { solidSum += a; solidN++; }
  }
  const dIn = cv.distance(inside, m.width, m.height);
  const dOut = cv.distance(outside, m.width, m.height);
  const body = solidN ? solidSum / solidN / 255 : 1;
  for (let i = 0; i < n; i++) {
    const sdf = inside[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
    const t = clamp((sdf + delta + 1) / 2, 0, 1);
    const cover = t * t * (3 - 2 * t);
    const a = src[4 * i + 3] / 255;
    const na = delta > 0 ? Math.max(a, cover * body) : a * cover;
    if (na > a && src[4 * i + 3] < 200) { out[4 * i] = rgb[0]; out[4 * i + 1] = rgb[1]; out[4 * i + 2] = rgb[2]; }
    out[4 * i + 3] = Math.round(255 * na);
  }
  return out;
}

export interface LineRaster {
  /** Straight-alpha RGBA cropped to the ink of the line. */
  rgba: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Cache of scaled glyph images (premultiplied), shared between lines of one render run. */
export class RenderCache {
  private map = new Map<string, { w: number; h: number; data: Uint8Array }>();
  private pressedMap = new Map<string, Uint8Array>();
  constructor(private limit = 400) {}
  get(g: Glyph, sx: number, sy: number, pressure: number, ink: [number, number, number] | null) {
    const pb = Math.round((pressure - 1) * 25); // pressure in steps of 4 %
    const w = Math.max(1, Math.round(g.meta.width * sx));
    const h = Math.max(1, Math.round(g.meta.height * sy));
    const key = `${g.meta.id}|${w}|${h}|${pb}`;
    let hit = this.map.get(key);
    if (hit) return hit;
    const pkey = `${g.meta.id}|${pb}`;
    let src = this.pressedMap.get(pkey);
    if (!src) {
      src = pressed(g, 1 + pb / 25, ink);
      // premultiply before resampling so that transparent pixels do not bleed colour
      for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3] / 255;
        src[i] = Math.round(src[i] * a); src[i + 1] = Math.round(src[i + 1] * a); src[i + 2] = Math.round(src[i + 2] * a);
      }
      if (this.pressedMap.size > this.limit) this.pressedMap.clear();
      this.pressedMap.set(pkey, src);
    }
    const shrink = w < g.meta.width || h < g.meta.height;
    const data = cv.resize(src, g.meta.width, g.meta.height, w, h, shrink ? 'area' : 'linear', 4);
    hit = { w, h, data };
    if (this.map.size > this.limit) this.map.clear();
    this.map.set(key, hit);
    return hit;
  }
}

export function renderLine(line: LineLayout, options: Partial<SynthOptions> = {}, cache = new RenderCache()): LineRaster | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of line.placed) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.g.meta.width * p.sx); y1 = Math.max(y1, p.y + p.g.meta.height * p.sy);
  }
  for (const s of line.strokes) for (let i = 0; i < s.pts.length; i += 3) {
    const r = s.pts[i + 2] + 2;
    x0 = Math.min(x0, s.pts[i] - r); y0 = Math.min(y0, s.pts[i + 1] - r); x1 = Math.max(x1, s.pts[i] + r); y1 = Math.max(y1, s.pts[i + 1] + r);
  }
  if (!Number.isFinite(x0)) return null;
  const ox = Math.floor(x0) - 1;
  const oy = Math.floor(y0) - 1;
  const W = Math.ceil(x1) - ox + 2;
  const H = Math.ceil(y1) - oy + 2;
  const buf = new Float32Array(W * H * 4); // premultiplied, 0..1
  for (const p of line.placed) {
    const im = cache.get(p.g, p.sx, p.sy, line.pressure, opts.inkColor);
    const dx = Math.round(p.x) - ox;
    const dy = Math.round(p.y) - oy;
    for (let y = 0; y < im.h; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < im.w; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= W) continue;
        const s = 4 * (y * im.w + x);
        const a = im.data[s + 3] / 255;
        if (a <= 0) continue;
        const t = 4 * (ty * W + tx);
        const k = 1 - a;
        buf[t] = im.data[s] / 255 + buf[t] * k;
        buf[t + 1] = im.data[s + 1] / 255 + buf[t + 1] * k;
        buf[t + 2] = im.data[s + 2] / 255 + buf[t + 2] * k;
        buf[t + 3] = a + buf[t + 3] * k;
      }
    }
  }
  // pen strokes: a round nib is stamped along the path on a 3× finer grid, then reduced, like drawing in a paint program
  const SS = 3;
  for (const s of line.strokes) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      const r = s.pts[i + 2] / 2 + 2 + s.soft;
      bx0 = Math.min(bx0, s.pts[i] - r); by0 = Math.min(by0, s.pts[i + 1] - r); bx1 = Math.max(bx1, s.pts[i] + r); by1 = Math.max(by1, s.pts[i + 1] + r);
    }
    const sx0 = Math.floor(bx0), sy0 = Math.floor(by0);
    const sw = Math.ceil(bx1) - sx0 + 1, sh = Math.ceil(by1) - sy0 + 1;
    const fine = new Uint8Array(sw * SS * sh * SS);
    const FW = sw * SS;
    const FH = sh * SS;
    for (let i = 0; i + 3 < s.pts.length; i += 3) {
      const ax = (s.pts[i] - sx0) * SS, ay = (s.pts[i + 1] - sy0) * SS, ar = (s.pts[i + 2] / 2) * SS;
      const bx = (s.pts[i + 3] - sx0) * SS, by = (s.pts[i + 4] - sy0) * SS, br = (s.pts[i + 5] / 2) * SS;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t, r = ar + (br - ar) * t;
        const r2 = r * r;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(FH - 1, Math.ceil(cy + r)); y++)
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(FW - 1, Math.ceil(cx + r)); x++)
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) fine[y * FW + x] = 1;
      }
    }
    let cov = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let c = 0;
      for (let yy = 0; yy < SS; yy++) for (let xx = 0; xx < SS; xx++) c += fine[(y * SS + yy) * FW + x * SS + xx];
      cov[y * sw + x] = c / (SS * SS);
    }
    // soften the edge to the softness of the photographed letters, otherwise the stroke looks drawn by a computer
    if (s.soft > 0.7) cov = cv.blur(cov, sw, sh, clamp(0.35 * s.soft, 0.3, 2.5));
    const r = s.rgb[0] / 255, g = s.rgb[1] / 255, b = s.rgb[2] / 255;
    for (let y = 0; y < sh; y++) {
      const ty = sy0 + y - oy;
      if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < sw; x++) {
        const tx = sx0 + x - ox;
        if (tx < 0 || tx >= W) continue;
        const a = cov[y * sw + x] * s.alpha;
        if (a <= 0.003) continue;
        const t = 4 * (ty * W + tx);
        const k = 1 - a;
        buf[t] = r * a + buf[t] * k; buf[t + 1] = g * a + buf[t + 1] * k; buf[t + 2] = b * a + buf[t + 2] * k; buf[t + 3] = a + buf[t + 3] * k;
      }
    }
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = buf[4 * i + 3];
    if (a <= 0.002) continue;
    rgba[4 * i] = Math.round(clamp(buf[4 * i] / a, 0, 1) * 255);
    rgba[4 * i + 1] = Math.round(clamp(buf[4 * i + 1] / a, 0, 1) * 255);
    rgba[4 * i + 2] = Math.round(clamp(buf[4 * i + 2] / a, 0, 1) * 255);
    rgba[4 * i + 3] = Math.round(clamp(a, 0, 1) * 255);
  }
  return { rgba, x: ox, y: oy, width: W, height: H };
}
