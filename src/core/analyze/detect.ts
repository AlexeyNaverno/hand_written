/**
 * Where the words are: a small neural text detector (PP-OCRv4 DBNet) marks the body zone of every word,
 * following its tilt and the curve of the row. The baseline and the top of lowercase letters are then snapped
 * to the ink of each word, so every word carries its own row line instead of sharing one straight line per row.
 *
 * The detector only says "text runs here": the exact lines come from the ink, as in the classical word
 * normalisation (bottoms of strokes for the baseline, tops for the x-line), but word by word.
 * Runs fully offline in the web worker; without the model the app falls back to the ruling/text analysis.
 */
import * as cv from '../cv';
import { RGBA, clamp, median } from '../types';
import { darkness, eraseRuling, inkMask, minChannel, WordBand } from './page';

/** Minimal shape of an onnxruntime session, so this module does not depend on ort types. */
export interface DetSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

export type TensorMaker = (data: Float32Array, dims: number[]) => unknown;

const odd = (v: number) => Math.round(v) | 1;

/** Probability threshold of the detector map; the model's own default. */
const TH = 0.3;

export async function detectWords(det: DetSession, mkTensor: TensorMaker, img: RGBA, side = 1400): Promise<WordBand[]> {
  const W = img.width;
  const H = img.height;
  const f = clamp(side / Math.max(W, H), 0.25, 2);
  const w = Math.max(32, Math.round((W * f) / 32) * 32);
  const h = Math.max(32, Math.round((H * f) / 32) * 32);
  // the model expects BGR, normalised to [-1, 1]
  const src = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data);
  const small = f === 1 && w === W ? img : { width: w, height: h, data: cv.resize(src, W, H, w, h, 'linear', 4) };
  const sdata = small.data instanceof Uint8Array ? small.data : new Uint8Array(small.data);
  const n = w * h;
  const t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const j = 4 * i;
    t[2 * n + i] = (sdata[j] / 255 - 0.5) / 0.5;
    t[n + i] = (sdata[j + 1] / 255 - 0.5) / 0.5;
    t[i] = (sdata[j + 2] / 255 - 0.5) / 0.5;
  }
  const res = await det.run({ [det.inputNames[0]]: mkTensor(t, [1, 3, h, w]) });
  const o = res[det.outputNames[0]];
  const ow = o.dims[3] as number;
  const oh = o.dims[2] as number;
  const P = o.data;

  // ink of the page at the same resolution as the detector map: the lines are snapped to it
  const gray = minChannel(small as RGBA);
  const d = darkness(gray, w, h, odd(Math.max(w, h) / 40));
  const m0 = inkMask(d, w, h);
  eraseRuling(d, w, h, m0.tLo, m0.tHi, Math.round(w / 10), Math.round(h / 10));
  const ink = inkMask(d, w, h, m0.inkLevel).ink;

  // connected regions of the probability map: one per word (or a tight group of words)
  const lab = new Int32Array(ow * oh);
  const regions: number[][] = [];
  for (let i = 0; i < ow * oh; i++) {
    if (P[i] <= TH || lab[i]) continue;
    const st = [i];
    lab[i] = regions.length + 1;
    const pts: number[] = [];
    while (st.length) {
      const p = st.pop()!;
      pts.push(p);
      const x = p % ow;
      const y = (p - x) / ow;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= ow || yy >= oh) continue;
        const q = yy * ow + xx;
        if (P[q] > TH && !lab[q]) {
          lab[q] = lab[i];
          st.push(q);
        }
      }
    }
    regions.push(pts);
  }
  const kx = w / ow;
  const ky = h / oh;

  interface Region { x0: number; x1: number; yc: (x: number) => number; T: number; base: number | null; top: number | null }
  const regs: Region[] = [];
  for (const pts of regions) {
    // centre curve of the band: mean row per column, fitted by a line or a gentle parabola
    const col = new Map<number, { s: number; n: number }>();
    for (const p of pts) {
      const x = p % ow;
      const y = Math.floor(p / ow);
      const c = col.get(x) ?? { s: 0, n: 0 };
      c.s += y;
      c.n++;
      col.set(x, c);
    }
    const xs = [...col.keys()].sort((a, b) => a - b);
    if (xs.length < 6) continue;
    const T = (pts.length / xs.length) * ky;
    if (T < 3) continue;
    const X = xs.map((x) => (x + 0.5) * kx);
    const Y = xs.map((x) => (col.get(x)!.s / col.get(x)!.n + 0.5) * ky);
    const mx = X.reduce((a, b) => a + b, 0) / X.length;
    const U = X.map((x) => x - mx);
    let coef: number[];
    const S = (k: number) => U.reduce((a, u) => a + u ** k, 0);
    const SY = (k: number) => U.reduce((a, u, i) => a + u ** k * Y[i], 0);
    if (X[X.length - 1] - X[0] <= 10 * T) {
      coef = [SY(0) / U.length, SY(1) / S(2), 0];
    } else {
      const A = [[U.length, S(1), S(2)], [S(1), S(2), S(3)], [S(2), S(3), S(4)]];
      const B = [SY(0), SY(1), SY(2)];
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) { const q = A[j][i] / A[i][i]; for (let k = i; k < 3; k++) A[j][k] -= q * A[i][k]; B[j] -= q * B[i]; }
      const c2 = B[2] / A[2][2];
      const c1 = (B[1] - A[1][2] * c2) / A[1][1];
      coef = [(B[0] - A[0][1] * c1 - A[0][2] * c2) / A[0][0], c1, c2];
    }
    regs.push({ x0: X[0], x1: X[X.length - 1], yc: (x: number) => coef[0] + coef[1] * (x - mx) + coef[2] * (x - mx) ** 2, T, base: null, top: null });
  }

  // snap: how far the bottoms and the tops of the strokes lie from the centre of each band
  const mode = (vals: number[], lo: number, hi: number, bin: number) => {
    const nb = Math.max(1, Math.ceil((hi - lo) / bin));
    const hst = new Float32Array(nb);
    for (const v of vals) if (v >= lo && v < hi) hst[Math.floor((v - lo) / bin)]++;
    let bi = 0;
    let bv = -1;
    for (let i = 0; i < nb; i++) {
      const s = hst[i] + 0.6 * ((hst[i - 1] ?? 0) + (hst[i + 1] ?? 0));
      if (s > bv) { bv = s; bi = i; }
    }
    return lo + (bi + 0.5) * bin;
  };
  const offsB: number[] = [];
  const offsT: number[] = [];
  for (const r of regs) {
    const low: number[] = [];
    const up: number[] = [];
    const pl: number[] = [];
    const pu: number[] = [];
    for (let x = Math.max(0, Math.round(r.x0 - r.T)); x <= Math.min(w - 1, Math.round(r.x1 + r.T)); x++) {
      const c = r.yc(x);
      // wider than the band itself: a narrow band must not clip the tops and bottoms it measures
      const a = Math.max(0, Math.round(c - 0.7 * r.T));
      const b = Math.min(h - 1, Math.round(c + 0.7 * r.T));
      let y = b;
      while (y >= a && !ink[y * w + x]) y--;
      if (y >= a) {
        while (y + 1 < h && ink[(y + 1) * w + x]) y++;
        pl.push(y - c);
      } else pl.push(NaN);
      y = a;
      while (y <= b && !ink[y * w + x]) y++;
      if (y <= b) {
        while (y - 1 >= 0 && ink[(y - 1) * w + x]) y--;
        pu.push(c - y);
      } else pu.push(NaN);
    }
    const win = 2;
    const extrema = (arr: number[], dst: number[]) => {
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isNaN(v)) continue;
        let isMax = true;
        for (let j = Math.max(0, i - win); j <= Math.min(arr.length - 1, i + win); j++) if (!Number.isNaN(arr[j]) && arr[j] > v) { isMax = false; break; }
        if (isMax && (i === 0 || arr[i - 1] !== v)) dst.push(v);
      }
    };
    extrema(pl, low);
    extrema(pu, up);
    if (low.length >= 3) { const v = mode(low, 0, 2.2 * r.T, Math.max(1, 0.12 * r.T)); r.base = v; offsB.push(v / r.T); }
    if (up.length >= 3) { const v = mode(up, 0, 2.2 * r.T, Math.max(1, 0.12 * r.T)); r.top = v; offsT.push(v / r.T); }
  }
  const rb = offsB.length ? median(offsB) : 0.8;
  const rt = offsT.length ? median(offsT) : 0.8;
  // a word with too little evidence, or far from the page's usual proportion, takes the usual one
  for (const r of regs) {
    if (r.base === null || Math.abs(r.base / r.T - rb) > 0.35) r.base = rb * r.T;
    if (r.top === null || Math.abs(r.top / r.T - rt) > 0.35) r.top = rt * r.T;
  }

  const bands: WordBand[] = [];
  const step = Math.max(1, Math.round(4 / kx));
  for (const r of regs) {
    const xs: number[] = [];
    const base: number[] = [];
    const top: number[] = [];
    for (let x = r.x0; ; x += step) {
      const xx = Math.min(x, r.x1);
      xs.push(xx / f);
      base.push((r.yc(xx) + r.base!) / f);
      top.push((r.yc(xx) - r.top!) / f);
      if (xx >= r.x1) break;
    }
    const xh = median(base.map((b, i) => b - top[i]));
    if (xh < 4) continue;
    bands.push({ x0: r.x0 / f, x1: r.x1 / f, xs, base, top, xh });
  }
  // stray fragments (a dash, a speck the detector caught) are far shorter and lower than real words
  const med = bands.length ? median(bands.map((b) => b.xh)) : 0;
  const words = bands.filter((b) => b.xh >= 0.45 * med && b.x1 - b.x0 >= 0.8 * med);
  words.sort((a, b) => a.x0 - b.x0);
  return words;
}
