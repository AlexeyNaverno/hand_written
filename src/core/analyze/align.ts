/**
 * Aligns a known line of text with the over-segmented line image.
 * Geometry proposes boundaries, recognition decides: every character takes one or more consecutive primitives,
 * and the cheapest assignment is found by dynamic programming. The cost combines per-frame letter probabilities
 * from the recogniser with rough shape expectations (width, ascender, descender, size).
 */
import { charPrior } from '../charset';
import { Boundary, Primitive } from './segment';

export interface FrameEvidence {
  /** Deslanted x of the frame centre. */
  xd: number;
  probs: Float32Array;
}

export interface AlignInput {
  text: string;
  primitives: Primitive[];
  boundaries: Boundary[];
  xh: number;
  sw: number;
  frames?: FrameEvidence[];
  classOf?: (ch: string) => number | undefined;
  /** Mean letter widths (in x-heights) already measured for this writer. */
  widths?: Map<string, number>;
}

export interface CharPlace {
  ch: string;
  /** Index in the text. */
  index: number;
  /** Primitive range [p0, p1); -1 when the character found no place. */
  p0: number;
  p1: number;
  cost: number;
}

export interface Alignment {
  places: CharPlace[];
  /** Primitives not used by any character (noise, crossed-out marks, parts of neighbours). */
  unused: number[];
  total: number;
}

const SKIP_PRIM = 3.5;
const SKIP_CHAR = 5;
const WORD_GAP = 0.5;

export function alignText(input: AlignInput): Alignment {
  const { primitives: prims, boundaries: bnd, xh } = input;
  const chars = [...input.text.replace(/\s+/g, ' ').trim()];
  const n = chars.length;
  const m = prims.length;
  const frames = input.frames ?? [];
  const gapLeft = (j: number) => (j >= m ? Infinity : bnd[prims[j].left].kind === 'gap' ? bnd[prims[j].left].gap / xh : 0);

  const evidence = (ch: string, xa: number, xb: number): number => {
    if (!frames.length || !input.classOf) return 0;
    const cls = input.classOf(ch);
    if (cls === undefined) return 0.7;
    const lo = xa - 0.2 * xh;
    const hi = xb + 0.2 * xh;
    let a = 0;
    let b = frames.length;
    while (a < b) { const mid = (a + b) >> 1; if (frames[mid].xd < lo) a = mid + 1; else b = mid; }
    let p = 0;
    let seen = false;
    for (let f = a; f < frames.length && frames[f].xd <= hi; f++) { seen = true; p = Math.max(p, frames[f].probs[cls]); }
    if (!seen) return 0.7;
    return Math.min(5, -Math.log(p + 2e-3));
  };

  const groupCost = (ch: string, j: number, k: number): number => {
    const pr = charPrior(ch);
    if (k > pr.maxParts) return Infinity;
    const first = prims[j];
    const last = prims[j + k - 1];
    let top = -Infinity;
    let bottom = Infinity;
    let mass = 0;
    let gapPenalty = 0;
    for (let q = j; q < j + k; q++) {
      top = Math.max(top, prims[q].top);
      bottom = Math.min(bottom, prims[q].bottom);
      mass += prims[q].mass;
      if (q > j) {
        const g = gapLeft(q);
        if (g > WORD_GAP) return Infinity;
        gapPenalty += g > 0 ? 0.3 + 2 * g : 0;
      }
    }
    const width = (last.xb - first.xa + 1) / xh;
    const expW = input.widths?.get(ch) ?? pr.width;
    let cost = 1.3 * Math.min(2.5, Math.abs(Math.log(Math.max(width, 0.05) / expW)));
    const height = top - bottom;
    if (pr.small) {
      // a dot or a dash: must be little ink at the expected height
      const inkArea = mass / (xh * xh);
      if (inkArea > 0.12 * Math.max(1, expW * 3) || height > 0.9) cost += 3;
      const centre = 0.5 * (top + bottom);
      cost += Math.min(2, 1.5 * Math.abs(centre - pr.level));
    } else {
      if (height < 0.45) cost += 3;
      if (pr.asc && top < 1.25) cost += 1.5;
      if (!pr.asc && top > 1.6) cost += 1.5;
      if (pr.desc && bottom > -0.25) cost += 1.5;
      if (!pr.desc && bottom < -0.55) cost += 1.5;
    }
    cost += gapPenalty + 0.15 * (k - 1);
    cost += evidence(ch, first.xa, last.xb);
    return cost;
  };

  // dp[i][j]: best cost having placed i characters and consumed j primitives
  const INF = 1e12;
  const W = m + 1;
  const dp = new Float64Array((n + 1) * W).fill(INF);
  const back = new Int32Array((n + 1) * W).fill(-1); // encodes the step: 0 skip prim, 1 skip char/space, 10+k match with k primitives
  dp[0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i * W + j];
      if (cur >= INF) continue;
      if (j < m) {
        const c = cur + SKIP_PRIM + Math.min(3, prims[j].mass / (xh * xh));
        if (c < dp[i * W + j + 1]) { dp[i * W + j + 1] = c; back[i * W + j + 1] = 0; }
      }
      if (i < n) {
        const ch = chars[i];
        if (ch === ' ') {
          const g = gapLeft(j);
          const c = cur + (j === 0 || g >= WORD_GAP ? 0 : 2.5);
          if (c < dp[(i + 1) * W + j]) { dp[(i + 1) * W + j] = c; back[(i + 1) * W + j] = 1; }
          continue;
        }
        const cs = cur + SKIP_CHAR;
        if (cs < dp[(i + 1) * W + j]) { dp[(i + 1) * W + j] = cs; back[(i + 1) * W + j] = 1; }
        const missingSpace = i > 0 && chars[i - 1] !== ' ' && j > 0 && gapLeft(j) >= 0.8 ? 2.5 : 0;
        const maxK = Math.min(charPrior(ch).maxParts, m - j);
        for (let k = 1; k <= maxK; k++) {
          const g = groupCost(ch, j, k);
          if (g === Infinity) break;
          const c = cur + g + missingSpace;
          const t = (i + 1) * W + j + k;
          if (c < dp[t]) { dp[t] = c; back[t] = 10 + k; }
        }
      }
    }
  }
  const places: CharPlace[] = chars.map((ch, index) => ({ ch, index, p0: -1, p1: -1, cost: 0 }));
  const used = new Uint8Array(m);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = back[i * W + j];
    if (step === 0) { j--; continue; }
    if (step === 1) { i--; places[i].cost = chars[i] === ' ' ? 0 : SKIP_CHAR; continue; }
    if (step >= 10) {
      const k = step - 10;
      i--;
      places[i].p0 = j - k;
      places[i].p1 = j;
      places[i].cost = dp[(i + 1) * W + j] - dp[i * W + j - k];
      for (let q = j - k; q < j; q++) used[q] = 1;
      j -= k;
      continue;
    }
    break; // unreachable state
  }
  const unused: number[] = [];
  for (let q = 0; q < m; q++) if (!used[q]) unused.push(q);
  return { places, unused, total: dp[n * W + m] };
}
