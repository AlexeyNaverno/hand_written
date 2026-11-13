/**
 * Page-level analysis of an ordinary handwritten sheet: ink map, skew, ruling,
 * text lines with a robust baseline and x-height.
 *
 * The baseline is a property of the text line, never of a single letter: letters later inherit it.
 */
import * as cv from '../cv';
import { bandContour, findPeaks, otsu, ransacLine, smooth1d, thin } from '../imgops';
import { RGBA, clamp, median } from '../types';

export interface TextLine {
  id: number;
  /** Baseline y = a·x + c in full-resolution page coordinates. */
  a: number;
  c: number;
  /** Distance from the baseline to the top of lowercase letters, px. */
  xHeight: number;
  x0: number;
  x1: number;
  points: number;
  inliers: number;
  /** The line is cut by the image border and should not be harvested. */
  partial: boolean;
}

export interface Ruling {
  /** Distance between ruling lines, full-resolution px. */
  pitch: number;
  periodicity: number;
  squared: boolean;
  /** Ruling lines y = a·x + c in full-resolution page coordinates. */
  lines: { a: number; c: number }[];
}

export interface PageAnalysis {
  width: number;
  height: number;
  skewDeg: number;
  ruling: Ruling | null;
  pxPerMm: number | null;
  strokeWidth: number;
  xHeight: number;
  /** Typical darkness (0..1) of solid ink, used to normalise glyph opacity. */
  inkLevel: number;
  lines: TextLine[];
}

export function minChannel(img: RGBA): Uint8Array {
  const n = img.width * img.height;
  const g = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3] / 255;
    // transparent pixels count as white paper
    const r = d[j] * a + 255 * (1 - a);
    const gg = d[j + 1] * a + 255 * (1 - a);
    const b = d[j + 2] * a + 255 * (1 - a);
    g[i] = Math.min(r, gg, b);
  }
  return g;
}

const odd = (v: number) => (Math.round(v) | 1);

/** Flat-fielded darkness map: 0 = paper, 1 = black. */
export function darkness(gray: Uint8Array, w: number, h: number, kernel: number): Float32Array {
  // paper estimate on a reduced copy: illumination changes slowly
  const f = Math.max(1, Math.floor(kernel / 12));
  const sw = Math.max(8, Math.round(w / f));
  const sh = Math.max(8, Math.round(h / f));
  const small = f > 1 ? cv.resize(gray, w, h, sw, sh, 'area') : gray;
  const k = odd(Math.max(5, kernel / f));
  let paper = cv.closeU8(small, sw, sh, k);
  paper = cv.blur(paper, sw, sh, k / 2);
  if (f > 1) paper = cv.resize(paper, sw, sh, w, h, 'linear');
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = clamp(1 - gray[i] / Math.max(paper[i], 1), 0, 1);
  return out;
}

export interface InkMask {
  ink: Uint8Array;
  strong: Uint8Array;
  inkLevel: number;
  tLo: number;
  tHi: number;
}

/**
 * Two thresholds relative to the darkness of solid ink; faint pixels survive only when attached to solid ink,
 * which keeps thin connecting strokes and drops paper texture.
 */
export function inkMask(d: Float32Array, w: number, h: number, level?: number): InkMask {
  let inkLevel = level ?? 0;
  if (!level) {
    const tAny = Math.max(0.06, otsu(d));
    const dark: number[] = [];
    const step = Math.max(1, Math.floor(d.length / 400000));
    for (let i = 0; i < d.length; i += step) if (d[i] > tAny) dark.push(d[i]);
    const tInk = dark.length > 50 ? otsu(dark) : 0.5;
    const solid = dark.filter((v) => v > tInk);
    inkLevel = solid.length ? median(solid) : Math.max(0.3, tInk);
  }
  const tHi = 0.5 * inkLevel;
  const tLo = 0.24 * inkLevel;
  const weak = new Uint8Array(w * h);
  const strong = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) {
    if (d[i] > tLo) weak[i] = 1;
    if (d[i] > tHi) strong[i] = 1;
  }
  const cc = cv.components(weak, w, h);
  const keep = new Uint8Array(cc.count);
  for (let i = 0; i < d.length; i++) if (strong[i]) keep[cc.labels[i]] = 1;
  keep[0] = 0;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) ink[i] = keep[cc.labels[i]];
  return { ink, strong, inkLevel, tLo, tHi };
}

export function strokeWidthOf(bin: Uint8Array, w: number, h: number): number {
  const dt = cv.distance(bin, w, h);
  const sk = thin(bin, w, h);
  const vals: number[] = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) vals.push(dt[i]);
  if (!vals.length) return 2;
  return Math.max(1.5, 2 * median(vals) - 0.5);
}

function rotationMatrix(cx: number, cy: number, deg: number): number[] {
  // same convention as cv.getRotationMatrix2D: positive = counter-clockwise on screen
  const r = (deg * Math.PI) / 180;
  const a = Math.cos(r);
  const b = Math.sin(r);
  return [a, b, (1 - a) * cx - b * cy, -b, a, b * cx + (1 - a) * cy];
}

function rowSharpness(img: Float32Array | Uint8Array, w: number, h: number): number {
  let prev = 0;
  let acc = 0;
  const y0 = Math.floor(h * 0.08);
  const y1 = Math.ceil(h * 0.92);
  for (let y = y0; y < y1; y++) {
    let s = 0;
    const o = y * w;
    for (let x = 0; x < w; x++) s += img[o + x];
    if (y > y0) acc += (s - prev) * (s - prev);
    prev = s;
  }
  return acc;
}

/** Angle (degrees) that makes rows of `img` sharpest; searched within ±span. */
function bestAngle(img: Float32Array, w: number, h: number, span: number): { deg: number; score: number; off: number } {
  const score = (deg: number) => rowSharpness(cv.warp(img, w, h, rotationMatrix(w / 2, h / 2, deg), w, h, 'linear', 0), w, h);
  let best = 0;
  let bs = -1;
  for (let a = -span; a <= span + 1e-6; a += 0.5) {
    const s = score(a);
    if (s > bs) { bs = s; best = a; }
  }
  const coarse = best;
  for (let a = coarse - 0.4; a <= coarse + 0.4 + 1e-6; a += 0.1) {
    const s = score(a);
    if (s > bs) { bs = s; best = a; }
  }
  const off = Math.max(score(best + 2), score(best - 2));
  return { deg: Math.round(best * 100) / 100, score: bs, off };
}

function autocorrPitch(prof: Float32Array, minLag: number): { lag: number; value: number } {
  const n = prof.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n || 1;
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = prof[i] - mean;
  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += q[i] * q[i];
  if (ac0 <= 0) return { lag: 0, value: 0 };
  const maxLag = Math.floor(n / 3);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += q[i] * q[i + lag];
    ac[lag] = s / ac0;
  }
  const peaks = findPeaks(ac, 0.08, Math.max(2, minLag >> 1));
  if (!peaks.length) return { lag: 0, value: 0 };
  // the first clear peak is the fundamental period
  const top = Math.max(...peaks.map((p) => p.value));
  const first = peaks.find((p) => p.value >= 0.6 * top)!;
  return { lag: first.pos, value: first.value };
}

interface Band {
  top: number;
  bottom: number;
  peak: number;
}

/** Core bands of text lines from the row profile of ink crossings (transitions paper→ink). */
function bandsFromCrossings(ink: Uint8Array, w: number, h: number, sw: number): Band[] {
  const cross = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const o = y * w;
    for (let x = 1; x < w; x++) if (ink[o + x] && !ink[o + x - 1]) c++;
    cross[y] = c;
  }
  const sm = smooth1d(cross, Math.max(1, sw * 1.2));
  let mx = 0;
  for (let y = 0; y < h; y++) mx = Math.max(mx, sm[y]);
  if (mx <= 0) return [];
  const peaks = findPeaks(sm, mx * 0.12, Math.max(4, Math.round(sw * 4)));
  const bands: Band[] = [];
  for (const p of peaks) {
    const thr = sm[p.pos] * 0.5;
    let t = p.pos;
    while (t > 0 && sm[t] > thr) t--;
    let b = p.pos;
    while (b < h - 1 && sm[b] > thr) b++;
    bands.push({ top: t, bottom: b, peak: p.pos });
  }
  return bands;
}

function removeRulingRows(ink: Uint8Array, w: number, h: number, rows: number[], half: number): void {
  for (const r of rows) {
    const a = Math.max(0, r - half);
    const b = Math.min(h, r + half + 1);
    for (let x = 0; x < w; x++) {
      let above = false;
      let below = false;
      for (let y = Math.max(0, a - 3); y < a; y++) if (ink[y * w + x]) above = true;
      for (let y = b; y < Math.min(h, b + 3); y++) if (ink[y * w + x]) below = true;
      if (!above && !below) for (let y = a; y < b; y++) ink[y * w + x] = 0;
    }
  }
}

export interface PageOptions {
  /** Longest side used for page-level analysis. */
  analysisSide?: number;
}

export function analyzePage(img: RGBA, opts: PageOptions = {}): PageAnalysis {
  const W = img.width;
  const H = img.height;
  const side = opts.analysisSide ?? 1800;
  const sc = Math.min(1, side / Math.max(W, H));
  const w = Math.max(16, Math.round(W * sc));
  const h = Math.max(16, Math.round(H * sc));
  const grayFull = minChannel(img);
  const gray = sc < 1 ? cv.resize(grayFull, W, H, w, h, 'area') : grayFull;
  const d0 = darkness(gray, w, h, odd(Math.max(w, h) / 40));
  const m0 = inkMask(d0, w, h);

  // --- ruling: faint, straight, periodic lines in the non-ink part of the sheet
  const nearInk = cv.dilateU8(m0.ink, w, h, 5);
  const faint = new Float32Array(w * h);
  for (let i = 0; i < faint.length; i++) faint[i] = nearInk[i] ? 0 : d0[i];
  const ra = bestAngle(faint, w, h, 5);
  let hasRuling = ra.score > 3 * ra.off && ra.score > 0;
  // --- skew: from ruling when present, otherwise from the text itself
  let skew = ra.deg;
  if (!hasRuling) {
    const inkF = new Float32Array(w * h);
    for (let i = 0; i < inkF.length; i++) inkF[i] = m0.ink[i];
    skew = bestAngle(inkF, w, h, 8).deg;
  }
  const M = rotationMatrix(w / 2, h / 2, skew);
  const d = Math.abs(skew) > 0.03 ? cv.warp(d0, w, h, M, w, h, 'linear', 0) : d0;
  const mask = inkMask(d, w, h, m0.inkLevel);
  const ink = mask.ink;

  let ruling: Ruling | null = null;
  let rulingRows: number[] = [];
  let pitch = 0;
  if (hasRuling) {
    const nearInk2 = cv.dilateU8(ink, w, h, 5);
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      let n = 0;
      for (let x = 0; x < w; x++) if (!nearInk2[y * w + x]) { s += d[y * w + x]; n++; }
      prof[y] = n ? s / n : 0;
    }
    const base = smooth1d(prof, 25);
    for (let y = 0; y < h; y++) prof[y] -= base[y];
    const ac = autocorrPitch(prof, 8);
    if (ac.lag > 0 && ac.value > 0.3) {
      pitch = ac.lag;
      const sorted = Array.from(prof).sort((p, q) => p - q);
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      rulingRows = findPeaks(prof, p99 * 0.25, Math.round(pitch * 0.7)).map((p) => p.pos);
      // squared paper has the same period along columns
      const cprof = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let y = 0; y < h; y++) if (!nearInk2[y * w + x]) { s += d[y * w + x]; n++; }
        cprof[x] = n ? s / n : 0;
      }
      const cbase = smooth1d(cprof, 25);
      for (let x = 0; x < w; x++) cprof[x] -= cbase[x];
      const acc = autocorrPitch(cprof, 8);
      const squared = acc.value > 0.3 && Math.abs(acc.lag - pitch) <= Math.max(2, 0.08 * pitch);
      ruling = { pitch: pitch / sc, periodicity: ac.value, squared, lines: [] };
      removeRulingRows(ink, w, h, rulingRows, 2);
    } else hasRuling = false;
  }

  const sw = strokeWidthOf(ink, w, h);
  // --- candidate lines
  interface Cand { row: number; span: number; top: number; bottom: number; }
  const cands: Cand[] = [];
  if (hasRuling && rulingRows.length >= 3) {
    for (const r of rulingRows) cands.push({ row: r, span: pitch, top: r - 0.4 * pitch, bottom: r + 0.08 * pitch });
  } else {
    const bands = bandsFromCrossings(ink, w, h, sw);
    const heights = bands.map((b) => b.bottom - b.top);
    const mh = heights.length ? median(heights) : 10;
    const gaps: number[] = [];
    for (let i = 1; i < bands.length; i++) gaps.push(bands[i].bottom - bands[i - 1].bottom);
    const span = gaps.length ? median(gaps) : mh * 3;
    for (const b of bands) {
      const bh = b.bottom - b.top;
      cands.push({ row: b.bottom, span: clamp(span, mh * 2, mh * 5), top: b.top, bottom: b.bottom + 0.2 * bh });
    }
  }

  interface Raw { a: number; c: number; xh: number; x0: number; x1: number; n: number; inl: number; row: number; px: number[]; py: number[]; }
  const raw: Raw[] = [];
  const win = Math.max(2, Math.round(sw));
  cands.forEach((cd, k) => {
    const P = cd.span;
    const low = bandContour(ink, w, h, cd.top, cd.bottom, true, win);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < low.xs.length; i++) if (Math.abs(low.ys[i] - cd.row) < 0.3 * P) { xs.push(low.xs[i]); ys.push(low.ys[i]); }
    if (xs.length < 5) return;
    const fit = ransacLine(xs, ys, Math.max(1.5, 0.045 * P), 0.05, k + 1);
    if (fit.count < 5 || fit.count < 0.3 * xs.length) return;
    // Letters rest on the line with their lowest points; stroke starts and connecting strokes end a little above it.
    // Shift the fitted line to the lower side of the inlier band instead of its middle.
    const resid: number[] = [];
    for (let i = 0; i < xs.length; i++) if (fit.inliers[i]) resid.push(ys[i] - (fit.a * xs[i] + fit.c));
    resid.sort((p, q) => p - q);
    fit.c += resid[Math.floor(resid.length * 0.65)] ?? 0;
    const up = bandContour(ink, w, h, cd.top, cd.bottom, false, win);
    const res: number[] = [];
    for (let i = 0; i < up.xs.length; i++) {
      const r = up.ys[i] - (fit.a * up.xs[i] + fit.c);
      if (r < -0.12 * P && r > -0.75 * P) res.push(r);
    }
    if (res.length < 4) return;
    const bin = Math.max(1, 0.03 * P);
    const nb = Math.ceil((0.63 * P) / bin) + 1;
    const hist = new Float32Array(nb);
    for (const r of res) hist[clamp(Math.floor((r + 0.75 * P) / bin), 0, nb - 1)]++;
    const hs = smooth1d(hist, 1.2);
    let bi = 0;
    for (let i = 1; i < nb; i++) if (hs[i] > hs[bi]) bi = i;
    const xh = 0.75 * P - (bi + 0.5) * bin;
    let x0 = w;
    let x1 = 0;
    for (let i = 0; i < low.xs.length; i++) { x0 = Math.min(x0, low.xs[i]); x1 = Math.max(x1, low.xs[i]); }
    raw.push({ a: fit.a, c: fit.c, xh, x0, x1, n: xs.length, inl: fit.count, row: cd.row, px: xs.filter((_, i) => fit.inliers[i]), py: ys.filter((_, i) => fit.inliers[i]) });
  });

  // A short line (a heading, the last line of a paragraph) cannot fix its own slope: it takes the slope of the long lines.
  const long = raw.filter((r) => r.inl >= 15 && r.x1 - r.x0 > 0.4 * w);
  if (long.length) {
    const slope = median(long.map((r) => r.a));
    for (const r of raw) {
      if (long.includes(r)) continue;
      const res = r.px.map((x, i) => r.py[i] - slope * x).sort((p, q) => p - q);
      r.a = slope;
      r.c = res[Math.floor(res.length * 0.65)] ?? r.c;
    }
  }

  const xhPage = raw.length ? median(raw.map((r) => r.xh)) : 0;
  // back to full-resolution, un-rotated page coordinates
  const r = (-skew * Math.PI) / 180;
  const ca = Math.cos(r);
  const sa = Math.sin(r);
  const back = (x: number, y: number) => {
    // inverse of rotationMatrix(w/2, h/2, skew), then undo the analysis scale
    const dx = x - w / 2;
    const dy = y - h / 2;
    return { x: (ca * dx + sa * dy + w / 2) / sc, y: (-sa * dx + ca * dy + h / 2) / sc };
  };
  const lines: TextLine[] = raw.map((ln, i) => {
    const xh = ln.xh > 0.75 * xhPage && ln.xh < 1.3 * xhPage ? ln.xh : xhPage;
    const p0 = back(ln.x0, ln.a * ln.x0 + ln.c);
    const p1 = back(ln.x1, ln.a * ln.x1 + ln.c);
    const a = (p1.y - p0.y) / Math.max(1e-6, p1.x - p0.x);
    const c = p0.y - a * p0.x;
    const mid = ln.a * (w / 2) + ln.c;
    const partial = mid - 1.15 * xh < 0 || mid + 0.35 * xh > h;
    return { id: i, a, c, xHeight: xh / sc, x0: Math.min(p0.x, p1.x), x1: Math.max(p0.x, p1.x), points: ln.n, inliers: ln.inl, partial };
  });
  if (ruling) {
    ruling.lines = rulingRows.map((row) => {
      const p0 = back(0, row);
      const p1 = back(w, row);
      const a = (p1.y - p0.y) / (p1.x - p0.x);
      return { a, c: p0.y - a * p0.x };
    });
  }
  const pxPerMm = ruling && ruling.squared ? ruling.pitch / 5 : null;
  return {
    width: W,
    height: H,
    skewDeg: skew,
    ruling,
    pxPerMm,
    strokeWidth: sw / sc,
    xHeight: xhPage / sc,
    inkLevel: m0.inkLevel,
    lines,
  };
}
