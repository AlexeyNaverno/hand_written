/**
 * One text line cut out of the page, rotated so that its baseline is horizontal and enlarged so that
 * a pen stroke is several pixels wide. All letter-level work happens in this strip.
 */
import * as cv from '../cv';
import { RGBA, clamp } from '../types';
import { propagateLabels } from '../imgops';
import { PageAnalysis, TextLine, darkness, inkMask } from './page';

export interface LineStrip {
  lineId: number;
  /** Strip pixels per source pixel. */
  scale: number;
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Darkness 0..1 (0 = paper). */
  dark: Float32Array;
  /** Ink that belongs to this line (neighbouring lines and specks removed). */
  ink: Uint8Array;
  baseY: number;
  xh: number;
  sw: number;
  inkLevel: number;
  /** Writing slant as tan(angle from vertical); positive = leaning right. */
  slant: number;
  /** Affine map strip → page: [a, b, tx, c, d, ty]. */
  toPage: number[];
  fromPage: number[];
  /** Ink of neighbouring lines inside the strip. */
  foreign: Uint8Array;
}

export const applyAffine = (M: number[], x: number, y: number) => ({ x: M[0] * x + M[1] * y + M[2], y: M[3] * x + M[4] * y + M[5] });

function invertAffine(M: number[]): number[] {
  const det = M[0] * M[4] - M[1] * M[3];
  const a = M[4] / det;
  const b = -M[1] / det;
  const c = -M[3] / det;
  const d = M[0] / det;
  return [a, b, -(a * M[2] + b * M[5]), c, d, -(c * M[2] + d * M[5])];
}

function estimateSlant(ink: Uint8Array, w: number, h: number, baseY: number, xh: number): number {
  const pts: number[] = [];
  const yTop = Math.max(0, Math.round(baseY - 2.2 * xh));
  const yBot = Math.min(h, Math.round(baseY + 1.2 * xh));
  for (let y = yTop; y < yBot; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) pts.push(x, y - baseY);
  if (pts.length < 40) return 0;
  const off = Math.ceil(1.3 * h);
  const hist = new Float32Array(w + 2 * off);
  let best = 0;
  let bestScore = -1;
  for (let s = -0.3; s <= 1.2001; s += 0.05) {
    hist.fill(0);
    for (let i = 0; i < pts.length; i += 2) hist[Math.round(pts[i] + s * pts[i + 1]) + off]++;
    let sc = 0;
    for (let i = 0; i < hist.length; i++) sc += hist[i] * hist[i];
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return Math.round(best * 100) / 100;
}

export function extractStrip(img: RGBA, page: PageAnalysis, line: TextLine): LineStrip {
  const xh0 = line.xHeight;
  const S = clamp(Math.max(6 / Math.max(page.strokeWidth, 1), 44 / xh0), 1, 4);
  const theta = Math.atan(line.a);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const marginX = 1.2 * xh0;
  const xa = Math.max(0, line.x0 - marginX);
  const xb = Math.min(page.width, line.x1 + marginX);
  const ya = line.a * xa + line.c;
  const up = 2.7 * xh0;
  const down = 1.9 * xh0;
  const baseY = Math.round(S * up);
  const width = Math.max(8, Math.round((S * (xb - xa)) / Math.max(0.2, ux)));
  const height = Math.round(S * (up + down));
  // page → strip
  const M = [S * ux, S * uy, -S * (xa * ux + ya * uy), -S * uy, S * ux, -S * (-xa * uy + ya * ux) + baseY];
  const rgba = cv.warp(img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    img.width, img.height, M, width, height, 'cubic', 255, 4);
  const n = width * height;
  const toPage = invertAffine(M);
  if (page.sheet) {
    // whatever lies outside the sheet (table, fingers) becomes blank paper
    const sh = page.sheet;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = Math.round((toPage[0] * x + toPage[1] * y + toPage[2]) * sh.scale);
        const py = Math.round((toPage[3] * x + toPage[4] * y + toPage[5]) * sh.scale);
        if (px < 0 || py < 0 || px >= sh.width || py >= sh.height || !sh.data[py * sh.width + px]) {
          const t = 4 * (y * width + x);
          rgba[t] = rgba[t + 1] = rgba[t + 2] = 255;
        }
      }
    }
  }
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (rgba[j + 3] < 255) { rgba[j] = rgba[j + 1] = rgba[j + 2] = 255; rgba[j + 3] = 255; }
    gray[i] = Math.min(rgba[j], rgba[j + 1], rgba[j + 2]);
  }
  const xh = xh0 * S;
  const dark = darkness(gray, width, height, Math.round(Math.max(15, 1.5 * xh)) | 1);
  const mask = inkMask(dark, width, height, page.inkLevel);
  const ink = mask.ink;

  // --- erase ruling lines that run through the strip, keeping strokes that cross them
  if (page.ruling) {
    const half = Math.max(1, Math.round(0.5 * S + 1));
    for (const rl of page.ruling.lines) {
      const y0 = M[3] * 0 + M[4] * rl.c + M[5];
      const xr = page.width;
      const y1 = M[3] * xr + M[4] * (rl.a * xr + rl.c) + M[5];
      const x0s = M[0] * 0 + M[1] * rl.c + M[2];
      const x1s = M[0] * xr + M[1] * (rl.a * xr + rl.c) + M[2];
      if (Math.abs(x1s - x0s) < 1) continue;
      const slope = (y1 - y0) / (x1s - x0s);
      for (let x = 0; x < width; x++) {
        const yc = Math.round(y0 + slope * (x - x0s));
        const a = yc - half;
        const b = yc + half;
        if (b < 0 || a >= height) continue;
        let above = false;
        let below = false;
        for (let y = Math.max(0, a - 3); y < Math.max(0, a); y++) if (ink[y * width + x]) above = true;
        for (let y = Math.min(height, b + 1); y < Math.min(height, b + 4); y++) if (ink[y * width + x]) below = true;
        if (!above && !below) for (let y = Math.max(0, a); y <= Math.min(height - 1, b); y++) ink[y * width + x] = 0;
      }
    }
  }

  // --- keep only the ink that belongs to this line.
  // Tightly written lines touch each other (a descender meets an ascender), so whole components cannot be
  // trusted. Every ink pixel goes to the line whose body zone is nearest *along the ink*.
  const mid = applyAffine(toPage, width / 2, baseY);
  const others = page.lines.filter((l) => l.id !== line.id).map((l) => {
    const y = l.a * mid.x + l.c;
    return M[3] * mid.x + M[4] * y + M[5];
  });
  // lines cut by the image border are often not detected; assume neighbours at the usual line spacing
  const sortedBases = page.lines.map((l) => l.a * mid.x + l.c).sort((p, q) => p - q);
  const gaps: number[] = [];
  for (let i = 1; i < sortedBases.length; i++) gaps.push((sortedBases[i] - sortedBases[i - 1]) * S);
  if (gaps.length) {
    gaps.sort((p, q) => p - q);
    const pitch = gaps[gaps.length >> 1];
    if (!others.some((v) => v > baseY + 0.5 * xh)) others.push(baseY + pitch);
    if (!others.some((v) => v < baseY - 0.5 * xh)) others.push(baseY - pitch);
  }
  const prevBase = Math.max(-Infinity, ...others.filter((v) => v < baseY - 0.5 * xh));
  const inBody = (y: number, b: number) => y >= b - 1.05 * xh && y <= b + 0.1 * xh;
  const rowKind = new Uint8Array(height); // 1 = body zone of this line, 2 = body zone of a neighbour
  for (let y = 0; y < height; y++) {
    if (inBody(y, baseY)) rowKind[y] = 1;
    else for (const ob of others) if (inBody(y, ob)) rowKind[y] = 2;
  }
  const cc0 = cv.components(ink, width, height);
  const nMine = new Int32Array(cc0.count);
  const nForeign = new Int32Array(cc0.count);
  for (let y = 0; y < height; y++) {
    if (!rowKind[y]) continue;
    for (let x = 0; x < width; x++) {
      const l = cc0.labels[y * width + x];
      if (l) (rowKind[y] === 1 ? nMine : nForeign)[l]++;
    }
  }
  // 1 = ours, 2 = neighbour's, 3 = written across both lines (to be split), 0 = no body ink (a loose mark)
  const verdict = new Uint8Array(cc0.count);
  const tip = 0.6 * xh * Math.max(2, 6 / 1); // a stroke end poking into the other line's zone is not a letter of that line
  for (let l = 1; l < cc0.count; l++) {
    const a = nMine[l];
    const f = nForeign[l];
    if (a && !f) verdict[l] = 1;
    else if (f && !a) verdict[l] = 2;
    else if (a && f) verdict[l] = f <= tip && f < 0.3 * a ? 1 : a <= tip && a < 0.3 * f ? 2 : 3;
  }
  const own = new Int32Array(n);
  let needSplit = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = verdict[cc0.labels[i]];
      if (v === 1 || v === 2) own[i] = v;
      else if (v === 3) { needSplit = true; if (rowKind[y]) own[i] = rowKind[y]; }
    }
  }
  // letters of two lines that touch: every pixel goes to the line whose body zone is nearest along the ink
  if (needSplit) propagateLabels(ink, own, width, height);
  // marks without any body-zone ink of their own: commas, dots, quotes, accents
  const loose = new Uint8Array(n);
  for (let i = 0; i < n; i++) loose[i] = ink[i] && own[i] === 0 ? 1 : 0;
  const cc = cv.components(loose, width, height);
  const sumY = new Float64Array(cc.count);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const l = cc.labels[y * width + x]; if (l) sumY[l] += y; }
  const keep = new Uint8Array(cc.count);
  const minArea = Math.max(4, 0.004 * xh * xh);
  const markTop = Math.max(prevBase + 0.7 * xh, baseY - 2.3 * xh);
  const markBot = baseY + 0.7 * xh;
  for (let l = 1; l < cc.count; l++) {
    const bw = cc.stats[l * 5 + 2];
    const bh = cc.stats[l * 5 + 3];
    const area = cc.stats[l * 5 + 4];
    const cy = sumY[l] / area;
    if (area >= minArea && bh <= 0.95 * xh && bw <= 1.3 * xh && cy > markTop && cy <= markBot) keep[l] = 1;
  }
  const foreign = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const mine = own[i] === 1 || keep[cc.labels[i]] ? 1 : 0;
    if (ink[i] && !mine) foreign[i] = 1;
    ink[i] = mine;
  }
  // drop specks
  const cc2 = cv.components(ink, width, height);
  for (let i = 0; i < n; i++) if (ink[i] && cc2.stats[cc2.labels[i] * 5 + 4] < minArea) ink[i] = 0;

  const dt = cv.distance(ink, width, height);
  // stroke width from the ridge of the distance map (local maxima along rows or columns)
  const ridge: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = dt[i];
      if (v < 1) continue;
      if ((v >= dt[i - 1] && v >= dt[i + 1]) || (v >= dt[i - width] && v >= dt[i + width])) ridge.push(v);
    }
  }
  ridge.sort((p, q) => p - q);
  const sw = ridge.length ? Math.max(2, 2 * ridge[ridge.length >> 1] - 0.5) : 3;
  const slant = estimateSlant(ink, width, height, baseY, xh);
  return { lineId: line.id, scale: S, width, height, rgba, dark, ink, baseY, xh, sw, inkLevel: page.inkLevel, slant, toPage, fromPage: M, foreign };
}
