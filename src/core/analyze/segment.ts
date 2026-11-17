/**
 * Over-segmentation of a text line into "primitives": pieces between places where a letter boundary is possible.
 * A boundary is possible at a gap, or where a line parallel to the writing slant crosses exactly one thin stroke
 * inside the body zone (a connecting stroke). Recognition later decides which boundaries are real.
 */
import * as cv from '../cv';
import { LineStrip } from './strip';

export interface Boundary {
  kind: 'gap' | 'cut';
  /** Position in the deslanted frame (strip x at the baseline). */
  xd: number;
  /** Gap width in strip px (0 for cuts). */
  gap: number;
  /** For cuts: the point on the connecting stroke, strip coordinates. */
  px: number;
  py: number;
}

export interface Primitive {
  /** Extent in the deslanted frame: strip x shifted by slant·(y − baseY), so that slanted strokes stand upright. */
  xa: number;
  xb: number;
  /** Extent relative to the baseline in x-heights: top > 0 above the baseline, bottom < 0 below. */
  top: number;
  bottom: number;
  width: number; // in x-heights
  mass: number;
  /** Boundary to the left of this primitive (index into boundaries). */
  left: number;
  right: number;
}

export interface Segmentation {
  /** Deslanted mask, width `dw`; deslanted x = strip x + slant·(y − baseY) + off. */
  dmask: Uint8Array;
  dw: number;
  off: number;
  boundaries: Boundary[];
  primitives: Primitive[];
}

export function deslantX(st: LineStrip, x: number, y: number): number {
  return x + st.slant * (y - st.baseY);
}

export function segmentLine(st: LineStrip): Segmentation {
  const { width: w, height: h, baseY, xh, sw } = st;
  const s = st.slant;
  const off = Math.ceil(Math.abs(s) * h) + 2;
  const dw = w + 2 * off;
  const dmask = cv.warp(st.ink, w, h, [1, s, -s * baseY + off, 0, 1, 0], dw, h, 'nearest', 0);
  const zTop = Math.max(0, Math.round(baseY - 1.3 * xh));
  const zBot = Math.min(h - 1, Math.round(baseY + 0.3 * xh));
  const colAny = new Uint8Array(dw);
  const single = new Uint8Array(dw);
  const cy = new Float32Array(dw);
  for (let x = 0; x < dw; x++) {
    let any = 0;
    for (let y = 0; y < h; y++) if (dmask[y * dw + x]) { any = 1; break; }
    colAny[x] = any;
    if (!any) continue;
    let runs = 0;
    let runLen = 0;
    let runMid = 0;
    let y = zTop;
    while (y <= zBot) {
      if (dmask[y * dw + x]) {
        let e = y;
        while (e + 1 <= zBot && dmask[(e + 1) * dw + x]) e++;
        // a run touching the zone edge continues outside: follow it to measure its real length
        let a = y;
        while (a - 1 >= 0 && dmask[(a - 1) * dw + x]) a--;
        let b = e;
        while (b + 1 < h && dmask[(b + 1) * dw + x]) b++;
        runs++;
        runLen = b - a + 1;
        runMid = 0.5 * (a + b);
        y = e + 1;
      } else y++;
    }
    if (runs === 1 && runLen <= 2.3 * sw) {
      single[x] = 1;
      cy[x] = runMid;
    }
  }

  // islands of consecutive ink columns
  const boundaries: Boundary[] = [];
  const primitives: Primitive[] = [];
  const addPrimitive = (xa: number, xb: number, left: number, right: number) => {
    let top = h;
    let bottom = -1;
    let mass = 0;
    for (let y = 0; y < h; y++) {
      for (let x = xa; x <= xb; x++) {
        if (!dmask[y * dw + x]) continue;
        mass++;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (mass === 0) return false;
    primitives.push({ xa: xa - off, xb: xb - off, top: (baseY - top) / xh, bottom: (baseY - bottom) / xh, width: (xb - xa + 1) / xh, mass, left, right });
    return true;
  };
  let x = 0;
  let lastEnd = -1;
  boundaries.push({ kind: 'gap', xd: -off, gap: Infinity, px: 0, py: baseY });
  while (x < dw) {
    if (!colAny[x]) { x++; continue; }
    const ia = x;
    while (x + 1 < dw && colAny[x + 1]) x++;
    const ib = x;
    x++;
    if (lastEnd >= 0) {
      const g = ia - lastEnd - 1;
      boundaries.push({ kind: 'gap', xd: 0.5 * (ia + lastEnd) - off, gap: g, px: 0.5 * (ia + lastEnd) - off, py: baseY });
    }
    lastEnd = ib;
    // cut candidates inside the island: groups of single-crossing columns with body on both sides
    let firstBody = -1;
    let lastBody = -1;
    for (let c = ia; c <= ib; c++) if (!single[c]) { if (firstBody < 0) firstBody = c; lastBody = c; }
    const cuts: number[] = [];
    if (firstBody >= 0) {
      let c = firstBody;
      while (c <= lastBody) {
        if (single[c]) {
          const ga = c;
          while (c + 1 <= lastBody && single[c + 1]) c++;
          const gb = c;
          if (gb - ga + 1 >= Math.max(2, 0.35 * sw)) cuts.push(Math.round(0.5 * (ga + gb)));
        }
        c++;
      }
    }
    // one connecting stroke often yields several groups; keep one cut per stroke
    const minDist = 0.24 * xh;
    const merged: number[] = [];
    for (let i = 0; i < cuts.length; ) {
      let j = i;
      while (j + 1 < cuts.length && cuts[j + 1] - cuts[j] < minDist) j++;
      const mean = 0.5 * (cuts[i] + cuts[j]);
      let bestC = cuts[i];
      for (let k = i; k <= j; k++) if (Math.abs(cuts[k] - mean) < Math.abs(bestC - mean)) bestC = cuts[k];
      merged.push(bestC);
      i = j + 1;
    }
    cuts.length = 0;
    cuts.push(...merged);
    let start = ia;
    let leftB = boundaries.length - 1;
    for (const cx of cuts) {
      const py = cy[cx];
      boundaries.push({ kind: 'cut', xd: cx - off, gap: 0, px: cx - off - s * (py - baseY), py });
      const rightB = boundaries.length - 1;
      addPrimitive(start, cx - 1, leftB, rightB);
      start = cx;
      leftB = rightB;
    }
    // the right boundary of the last piece is the next gap, added when the next island starts
    addPrimitive(start, ib, leftB, boundaries.length);
  }
  boundaries.push({ kind: 'gap', xd: dw - off, gap: Infinity, px: w, py: baseY });
  return { dmask, dw, off, boundaries, primitives };
}
