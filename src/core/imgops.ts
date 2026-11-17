/** Small image/geometry routines that OpenCV.js does not provide in its default build. */
import { Rng } from './types';

export function otsu(values: ArrayLike<number>, bins = 256, lo = 0, hi = 1): number {
  const hist = new Float64Array(bins);
  const n = values.length;
  if (!n) return 0.5 * (lo + hi);
  const k = (bins - 1) / (hi - lo || 1);
  for (let i = 0; i < n; i++) {
    let b = Math.round((values[i] - lo) * k);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) {
      best = v;
      bestT = t;
    }
  }
  return lo + (bestT + 0.5) / k;
}

export function smooth1d(a: ArrayLike<number>, sigma: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  if (sigma <= 0.01) {
    for (let i = 0; i < n; i++) out[i] = a[i];
    return out;
  }
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    s += k[i + r];
  }
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = -r; j <= r; j++) {
      const q = i + j < 0 ? 0 : i + j >= n ? n - 1 : i + j;
      v += a[q] * k[j + r];
    }
    out[i] = v / s;
  }
  return out;
}

export interface Peak {
  pos: number;
  value: number;
  prominence: number;
}

/** Local maxima with a minimum prominence and minimum mutual distance (strongest first). */
export function findPeaks(a: ArrayLike<number>, minProminence: number, minDistance: number): Peak[] {
  const n = a.length;
  const cand: Peak[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(a[i] > a[i - 1] && a[i] >= a[i + 1])) continue;
    let lmin = a[i];
    for (let j = i - 1; j >= 0 && a[j] <= a[i]; j--) if (a[j] < lmin) lmin = a[j];
    let rmin = a[i];
    for (let j = i + 1; j < n && a[j] <= a[i]; j++) if (a[j] < rmin) rmin = a[j];
    const prom = a[i] - Math.max(lmin, rmin);
    if (prom >= minProminence) cand.push({ pos: i, value: a[i], prominence: prom });
  }
  cand.sort((p, q) => q.value - p.value);
  const kept: Peak[] = [];
  for (const p of cand) if (kept.every((q) => Math.abs(q.pos - p.pos) >= minDistance)) kept.push(p);
  return kept.sort((p, q) => p.pos - q.pos);
}

/** Zhang–Suen thinning. Input and output are 0/1 masks. */
export function thin(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = src.slice();
  const del: number[] = [];
  let changed = true;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a =
            (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
          if (a !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(y * w + x);
        }
      }
      if (del.length) changed = true;
      for (const i of del) img[i] = 0;
    }
  }
  return img;
}

const NB8 = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];

export function neighbours(sk: Uint8Array, w: number, h: number, i: number): number[] {
  const x = i % w;
  const y = (i - x) / w;
  const out: number[] = [];
  for (let k = 0; k < 16; k += 2) {
    const nx = x + NB8[k];
    const ny = y + NB8[k + 1];
    if (nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx]) out.push(ny * w + nx);
  }
  return out;
}

/** Remove skeleton spurs shorter than `minLen` pixels (endpoint to junction). */
export function pruneSpurs(sk: Uint8Array, w: number, h: number, minLen: number, rounds = 2): Uint8Array {
  const out = sk.slice();
  for (let r = 0; r < rounds; r++) {
    let removed = false;
    for (let i = 0; i < out.length; i++) {
      if (!out[i] || neighbours(out, w, h, i).length !== 1) continue;
      const path = [i];
      let prev = -1;
      let cur = i;
      let hitJunction = false;
      while (path.length <= minLen) {
        const nb = neighbours(out, w, h, cur).filter((q) => q !== prev && !path.includes(q));
        if (nb.length !== 1) {
          hitJunction = nb.length > 1;
          break;
        }
        prev = cur;
        cur = nb[0];
        if (neighbours(out, w, h, cur).length >= 3) {
          hitJunction = true;
          break;
        }
        path.push(cur);
      }
      if (hitJunction && path.length <= minLen) {
        for (const p of path) out[p] = 0;
        removed = true;
      }
    }
    if (!removed) break;
  }
  return out;
}

export interface LineFit {
  a: number;
  c: number;
  inliers: boolean[];
  count: number;
  rms: number;
}

/** Robust line y = a·x + c through points; slope limited to |a| ≤ maxSlope. */
export function ransacLine(xs: number[], ys: number[], tol: number, maxSlope: number, seed = 1, iters = 400): LineFit {
  const n = xs.length;
  const rng = new Rng(seed);
  let bestCount = -1;
  let ba = 0;
  let bc = n ? ys.slice().sort((p, q) => p - q)[n >> 1] : 0;
  const count = (a: number, c: number) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (Math.abs(ys[i] - (a * xs[i] + c)) < tol) k++;
    return k;
  };
  bestCount = count(0, bc);
  if (n >= 2) {
    const span = Math.max(...xs) - Math.min(...xs);
    for (let it = 0; it < iters; it++) {
      const i = rng.int(n);
      const j = rng.int(n);
      if (Math.abs(xs[i] - xs[j]) < Math.max(4, span * 0.15)) continue;
      const a = (ys[j] - ys[i]) / (xs[j] - xs[i]);
      if (Math.abs(a) > maxSlope) continue;
      const c = ys[i] - a * xs[i];
      const k = count(a, c);
      if (k > bestCount) {
        bestCount = k;
        ba = a;
        bc = c;
      }
    }
  }
  // least-squares polish on inliers
  let inl = xs.map((x, i) => Math.abs(ys[i] - (ba * x + bc)) < tol);
  for (let round = 0; round < 2; round++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (let i = 0; i < n; i++) {
      if (!inl[i]) continue;
      sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; m++;
    }
    const den = m * sxx - sx * sx;
    if (m >= 2 && Math.abs(den) > 1e-6) {
      const a = (m * sxy - sx * sy) / den;
      if (Math.abs(a) <= maxSlope) {
        ba = a;
        bc = (sy - a * sx) / m;
      } else bc = sy / m - ba * (sx / m);
    } else if (m >= 1) bc = sy / m - ba * (sx / m);
    inl = xs.map((x, i) => Math.abs(ys[i] - (ba * x + bc)) < tol);
  }
  let ss = 0, m = 0;
  for (let i = 0; i < n; i++) if (inl[i]) { const d = ys[i] - (ba * xs[i] + bc); ss += d * d; m++; }
  return { a: ba, c: bc, inliers: inl, count: m, rms: m ? Math.sqrt(ss / m) : 0 };
}

/**
 * Local extrema of the lower (or upper) ink contour inside rows [y0, y1).
 * For each column the lowest (highest) ink pixel is taken; a point is kept where that value is extreme within ±win columns.
 */
export function contourExtrema(bin: Uint8Array, w: number, y0: number, y1: number, lower: boolean, win: number, x0 = 0, x1 = w) {
  const n = x1 - x0;
  const prof = new Float32Array(n).fill(NaN);
  for (let x = x0; x < x1; x++) {
    if (lower) {
      for (let y = y1 - 1; y >= y0; y--) if (bin[y * w + x]) { prof[x - x0] = y; break; }
    } else {
      for (let y = y0; y < y1; y++) if (bin[y * w + x]) { prof[x - x0] = y; break; }
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = prof[i];
    if (Number.isNaN(v)) continue;
    let ext = v;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
      const q = prof[j];
      if (Number.isNaN(q)) continue;
      if (lower ? q > ext : q < ext) ext = q;
    }
    if (v === ext && (i === 0 || prof[i - 1] !== v)) {
      xs.push(i + x0);
      ys.push(v);
    }
  }
  return { xs, ys };
}

/**
 * Contour of the strokes that pass through a horizontal band (the body zone of a text line).
 * For every column the ink run that intersects the band is followed down (or up) to its end, so that
 * ascenders of the next line and stray marks outside the band do not hide the letters of this line.
 * Returns local extrema of that contour (candidate baseline or x-line points).
 */
export function bandContour(
  bin: Uint8Array,
  w: number,
  h: number,
  bandTop: number,
  bandBottom: number,
  lower: boolean,
  win: number,
  x0 = 0,
  x1 = w,
) {
  const bt = Math.max(0, Math.round(bandTop));
  const bb = Math.min(h - 1, Math.round(bandBottom));
  const n = x1 - x0;
  const prof = new Float32Array(n).fill(NaN);
  for (let x = x0; x < x1; x++) {
    if (lower) {
      let y = bb;
      while (y >= bt && !bin[y * w + x]) y--;
      if (y < bt) continue;
      while (y + 1 < h && bin[(y + 1) * w + x]) y++;
      prof[x - x0] = y;
    } else {
      let y = bt;
      while (y <= bb && !bin[y * w + x]) y++;
      if (y > bb) continue;
      while (y - 1 >= 0 && bin[(y - 1) * w + x]) y--;
      prof[x - x0] = y;
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = prof[i];
    if (Number.isNaN(v)) continue;
    let ext = v;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
      const q = prof[j];
      if (Number.isNaN(q)) continue;
      if (lower ? q > ext : q < ext) ext = q;
    }
    if (v === ext && (i === 0 || prof[i - 1] !== v)) {
      xs.push(i + x0);
      ys.push(v);
    }
  }
  return { xs, ys };
}

/**
 * Give every mask pixel the label of the nearest seed pixel (two-pass chamfer propagation, repeated twice).
 * `labels` holds seed labels (> 0) and 0 elsewhere; the result is written in place for all mask pixels.
 */
export function propagateLabels(mask: Uint8Array, labels: Int32Array, w: number, h: number): void {
  const INF = 1e9;
  const dist = new Float32Array(w * h).fill(INF);
  for (let i = 0; i < w * h; i++) if (labels[i] > 0) dist[i] = 0;
  const relax = (i: number, j: number, cost: number) => {
    if (!mask[j] && labels[j] <= 0) return;
    const d = dist[j] + cost;
    if (d < dist[i]) {
      dist[i] = d;
      labels[i] = labels[j];
    }
  };
  for (let round = 0; round < 3; round++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (x > 0) relax(i, i - 1, 1);
        if (y > 0) {
          relax(i, i - w, 1);
          if (x > 0) relax(i, i - w - 1, 1.414);
          if (x < w - 1) relax(i, i - w + 1, 1.414);
        }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (x < w - 1) relax(i, i + 1, 1);
        if (y < h - 1) {
          relax(i, i + w, 1);
          if (x < w - 1) relax(i, i + w + 1, 1.414);
          if (x > 0) relax(i, i + w - 1, 1.414);
        }
      }
    }
  }
}

/** Keep weak pixels only when their connected component contains a strong pixel. */
export function hysteresis(weak: Uint8Array, strong: Uint8Array, labels: Int32Array, count: number): Uint8Array {
  const keep = new Uint8Array(count);
  for (let i = 0; i < weak.length; i++) if (strong[i]) keep[labels[i]] = 1;
  keep[0] = 0;
  const out = new Uint8Array(weak.length);
  for (let i = 0; i < weak.length; i++) out[i] = keep[labels[i]];
  return out;
}
