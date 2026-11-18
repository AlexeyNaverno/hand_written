import { pruneSpurs, thin } from './imgops';
import { clamp } from './types';

export type Quad = [[number, number], [number, number], [number, number], [number, number]];
export interface RectifiedPage { rgba: Uint8Array; width: number; height: number }
export interface VectorStroke { points: [number, number][] }
export interface GlyphVector {
  schema: 1;
  method: 'skeleton-trace';
  /** Pen order cannot be inferred from one raster image. */
  direction: 'unknown';
  confidence: number;
  strokes: VectorStroke[];
}

/** Trace the raster's thinned centreline into ordered polylines; this is an editable-quality starting point, not pen order. */
export function vectorizeGlyph(rgba: Uint8Array, w: number, h: number): GlyphVector {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[4 * i + 3] >= 48 ? 1 : 0;
  const sk = pruneSpurs(thin(mask, w, h), w, h, 2, 1);
  const links = (i: number) => {
    const x = i % w, y = Math.floor(i / w), out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !sk[ny * w + nx]) continue;
      // Suppress diagonal corner shortcuts when an orthogonal connection exists.
      if (dx && dy && (sk[y * w + nx] || sk[ny * w + x])) continue;
      out.push(ny * w + nx);
    }
    return out;
  };
  const degree = new Uint8Array(sk.length);
  const active: number[] = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) { active.push(i); degree[i] = links(i).length; }
  const visited = new Set<string>();
  const edge = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const strokes: VectorStroke[] = [];
  const trace = (start: number, next: number) => {
    const path = [start];
    let prev = start, cur = next;
    visited.add(edge(prev, cur)); path.push(cur);
    for (let steps = 0; steps < sk.length; steps++) {
      if (degree[cur] !== 2) break;
      const n = links(cur).find((q) => q !== prev && !visited.has(edge(cur, q)));
      if (n === undefined) break;
      visited.add(edge(cur, n)); prev = cur; cur = n; path.push(cur);
      if (cur === start) break;
    }
    if (path.length >= 2) strokes.push({ points: path.map((i) => [i % w, Math.floor(i / w)] as [number, number]) });
  };
  // Branches and ends delimit stable path segments.
  for (const i of active) if (degree[i] !== 2) for (const n of links(i)) if (!visited.has(edge(i, n))) trace(i, n);
  // Remaining degree-two components are closed loops.
  for (const i of active) for (const n of links(i)) if (!visited.has(edge(i, n))) trace(i, n);
  strokes.sort((a, b) => {
    const pa = a.points[0], pb = b.points[0];
    return pa[1] - pb[1] || pa[0] - pb[0];
  });
  return { schema: 1, method: 'skeleton-trace', direction: 'unknown', confidence: strokes.length ? 0.3 : 0, strokes };
}

/** Warp a normalized TL, TR, BR, BL quadrilateral to its front-facing rectangular raster. */
export async function rectifyQuad(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, quad: Quad, maxSide = 2400): Promise<RectifiedPage> {
  if (rgba.length !== w * h * 4 || w < 2 || h < 2 || !Number.isFinite(maxSide) || maxSide < 2) throw new Error('Invalid image dimensions');
  if (quad.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)) throw new Error('Corners must be normalized image coordinates');
  const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  const turns = quad.map((p, i) => cross(p, quad[(i + 1) % 4], quad[(i + 2) % 4]));
  if (turns.some((v) => Math.abs(v) < 1e-6) || !(turns.every((v) => v > 0) || turns.every((v) => v < 0))) throw new Error('Corners must form a convex, non-crossing quadrilateral in TL, TR, BR, BL order');
  const distance = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
  const outW = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const outH = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  if (outW < 2 || outH < 2) throw new Error('The selected area is too small');
  const scale = Math.min(1, maxSide / Math.max(outW, outH));
  const width = Math.max(2, Math.round(outW * scale));
  const height = Math.max(2, Math.round(outH * scale));
  const source: [number, number][] = quad.map(([x, y]) => [x * (w - 1), y * (h - 1)]);
  const cv = await import('./cv');
  await cv.loadCV();
  return { rgba: cv.warpPerspectiveRGBA(rgba, w, h, source, width, height), width, height };
}

export interface TrimmedCell {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Tight, ink-only bounds in the returned transparent PNG. */
  bbox: [number, number, number, number];
}

/** Remove the paper colour from one already-inset cell, then trim and scale its ink to at most 64 px high. */
export function trimInkCell(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): TrimmedCell | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = 4 * (y * width + x);
    const lum = .299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2];
    if (lum < 218) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  if (maxX < minX || maxY < minY) return null;
  const inkW = maxX - minX + 1, inkH = maxY - minY + 1;
  const margin = Math.max(2, Math.round(Math.max(inkW, inkH) * .1));
  const sx = Math.max(0, minX - margin), sy = Math.max(0, minY - margin);
  const ex = Math.min(width, maxX + margin + 1), ey = Math.min(height, maxY + margin + 1);
  const scale = Math.min(1, 64 / inkH);
  const outW = Math.max(2, Math.round((ex - sx) * scale));
  const outH = Math.max(2, Math.round((ey - sy) * scale));
  const ox = Math.round((minX - sx) * scale), oy = Math.round((minY - sy) * scale);
  const iw = Math.max(1, Math.round(inkW * scale)), ih = Math.max(1, Math.round(inkH * scale));
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const ix = clamp(Math.round(minX + x / scale), 0, width - 1);
    const iy = clamp(Math.round(minY + y / scale), 0, height - 1);
    const si = 4 * (iy * width + ix), di = 4 * ((oy + y) * outW + ox + x);
    const lum = .299 * pixels[si] + .587 * pixels[si + 1] + .114 * pixels[si + 2];
    const alpha = clamp(Math.round((245 - lum) * 2.7), 0, 255);
    if (alpha < 10) continue;
    out[di] = pixels[si]; out[di + 1] = pixels[si + 1]; out[di + 2] = pixels[si + 2]; out[di + 3] = alpha;
  }
  return { rgba: out, width: outW, height: outH, bbox: [ox, oy, ox + iw, oy + ih] };
}

export function whitePaper(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = Math.round(rgba[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}
