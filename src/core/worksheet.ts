import { clamp } from './types';

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
