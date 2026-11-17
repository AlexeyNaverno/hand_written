/**
 * Cuts letters out of an aligned line and measures them: colour image with transparency, baseline, x-height,
 * and the entry/exit joints (two points each, on the stroke centre line).
 */
import * as cv from '../cv';
import { entryLevel, exitLevel, isJoining, isUpper, JoinLevel } from '../charset';
import { neighbours, propagateLabels, pruneSpurs, thin } from '../imgops';
import { Glyph, GlyphMeta, Joint, Position } from '../library';
import { clamp, median } from '../types';
import { CharPlace } from './align';
import { LineAnalysis } from './line';

export interface ExtractOptions {
  file: string;
  pxPerMm: number | null;
  /** Characters with an alignment cost above this are still cut out but marked as not automatic. */
  autoCost?: number;
}

interface Seg {
  place: CharPlace;
  xa: number;
  xb: number;
  /** Boundary objects on both sides when the neighbour is an adjacent placed character. */
  leftCut: { px: number; py: number } | null;
  rightCut: { px: number; py: number } | null;
  prev: string;
  next: string;
  position: Position;
}

export function extractGlyphs(la: LineAnalysis, places: CharPlace[], opts: ExtractOptions): Glyph[] {
  const st = la.strip;
  const { width: W, height: H, baseY, xh, sw } = st;
  const prims = la.seg.primitives;
  const bnd = la.seg.boundaries;
  const placed = places.filter((p) => p.p0 >= 0 && p.ch !== ' ');
  if (!placed.length) return [];
  const chars = places.map((p) => p.ch);

  const segs: Seg[] = placed.map((place) => {
    const prevCh = place.index > 0 ? chars[place.index - 1] : ' ';
    const nextCh = place.index + 1 < chars.length ? chars[place.index + 1] : ' ';
    const prevLetter = prevCh !== ' ' && isJoining(prevCh);
    const nextLetter = nextCh !== ' ' && isJoining(nextCh);
    const position: Position = !isJoining(place.ch) ? 'isolated' : prevLetter && nextLetter ? 'medial' : nextLetter ? 'initial' : prevLetter ? 'final' : 'isolated';
    return { place, xa: prims[place.p0].xa, xb: prims[place.p1 - 1].xb, leftCut: null, rightCut: null, prev: prevCh === ' ' ? '' : prevCh, next: nextCh === ' ' ? '' : nextCh, position };
  });
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    if (a.place.p1 !== b.place.p0 || b.place.index !== a.place.index + 1) continue;
    const bd = bnd[prims[b.place.p0].left];
    if (bd.kind === 'cut') {
      a.rightCut = { px: bd.px, py: bd.py };
      b.leftCut = { px: bd.px, py: bd.py };
    }
  }

  // --- skeleton, cut at the chosen boundaries, labelled by letter
  let sk = thin(st.ink, W, H);
  sk = pruneSpurs(sk, W, H, Math.round(1.2 * sw));
  const erase = (px: number, py: number, r: number) => {
    for (let y = Math.max(0, Math.round(py - r)); y <= Math.min(H - 1, Math.round(py + r)); y++)
      for (let x = Math.max(0, Math.round(px - r)); x <= Math.min(W - 1, Math.round(px + r)); x++)
        if ((x - px) * (x - px) + (y - py) * (y - py) <= r * r) sk[y * W + x] = 0;
  };
  const skFull = sk.slice();
  for (const s of segs) if (s.rightCut) erase(s.rightCut.px, s.rightCut.py, 2.2);
  const cc = cv.components(sk, W, H);
  const xsBody: number[][] = Array.from({ length: cc.count }, () => []);
  const xsAll: number[][] = Array.from({ length: cc.count }, () => []);
  for (let y = 0; y < H; y++) {
    const body = y >= baseY - 1.1 * xh && y <= baseY + 0.1 * xh;
    for (let x = 0; x < W; x++) {
      const l = cc.labels[y * W + x];
      if (!l) continue;
      const xd = x + st.slant * (y - baseY);
      xsAll[l].push(xd);
      if (body) xsBody[l].push(xd);
    }
  }
  const segOf = new Int32Array(cc.count).fill(0);
  for (let l = 1; l < cc.count; l++) {
    const anchor = median(xsBody[l].length >= 3 ? xsBody[l] : xsAll[l]);
    let best = -1;
    for (let i = 0; i < segs.length; i++) if (anchor >= segs[i].xa - 0.5 && anchor <= segs[i].xb + 0.5) { best = i; break; }
    segOf[l] = best + 1;
  }
  const owner = new Int32Array(W * H);
  // pixels of unassigned skeleton parts get a label that no letter uses, so that they do not leak into neighbours
  const NONE = segs.length + 1;
  for (let i = 0; i < W * H; i++) if (cc.labels[i]) owner[i] = segOf[cc.labels[i]] || NONE;
  propagateLabels(st.ink, owner, W, H);
  const dt = cv.distance(st.ink, W, H);

  const lo = 0.1 * st.inkLevel;
  const hi = 0.7 * st.inkLevel;
  const glyphs: Glyph[] = [];
  const L = Math.max(4, Math.round(2.5 * sw));

  /** Walk along this letter's skeleton from a start pixel, collecting points up to L steps away. */
  const arm = (start: number, idx: number): number[] => {
    const seen = new Set<number>([start]);
    let frontier = [start];
    const pts: number[] = [];
    for (let step = 0; step < L && frontier.length; step++) {
      const nxt: number[] = [];
      for (const p of frontier) {
        for (const q of neighbours(skFull, W, H, p)) {
          if (seen.has(q) || owner[q] !== idx) continue;
          seen.add(q);
          nxt.push(q);
          pts.push(q);
        }
      }
      frontier = nxt;
    }
    return pts;
  };
  const tangent = (p0x: number, p0y: number, pts: number[]) => {
    if (pts.length < 3) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p % W; my += Math.floor(p / W); }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const dx = (p % W) - mx; const dy = Math.floor(p / W) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let tx = Math.cos(ang), ty = Math.sin(ang);
    if (tx * (mx - p0x) + ty * (my - p0y) < 0) { tx = -tx; ty = -ty; }
    const tr = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    return { tx, ty, straight: 1 - Math.sqrt(Math.max(0, l2) / Math.max(1e-6, l1)) };
  };
  const levelOf = (y: number): JoinLevel => { const r = (baseY - y) / xh; return r < 0.42 ? 'low' : r > 0.72 ? 'high' : 'mid'; };
  const nearestSkel = (px: number, py: number, idx: number, r: number): number => {
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, Math.round(py - r)); y <= Math.min(H - 1, Math.round(py + r)); y++)
      for (let x = Math.max(0, Math.round(px - r)); x <= Math.min(W - 1, Math.round(px + r)); x++) {
        const i = y * W + x;
        if (!skFull[i] || owner[i] !== idx) continue;
        const d = (x - px) * (x - px) + (y - py) * (y - py);
        if (d < bd) { bd = d; best = i; }
      }
    return best;
  };

  segs.forEach((s, si) => {
    const idx = si + 1;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, count = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (owner[y * W + x] === idx && st.ink[y * W + x]) {
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (count < 6) return;
    const pad = 3;
    const gx = Math.max(0, x0 - pad), gy = Math.max(0, y0 - pad);
    const gw = Math.min(W - 1, x1 + pad) - gx + 1, gh = Math.min(H - 1, y1 + pad) - gy + 1;
    const rgba = new Uint8Array(gw * gh * 4);
    const cr: number[] = [], cg: number[] = [], cb: number[] = [];
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const sx = gx + x, sy = gy + y, i = sy * W + sx;
        let mine = false;
        if (st.ink[i]) mine = owner[i] === idx;
        else if (st.dark[i] > lo) {
          // soft edge: belongs to the letter whose ink is nearest
          let bd = 99;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = sx + dx, yy = sy + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (!st.ink[j]) continue;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; mine = owner[j] === idx; }
          }
        }
        if (!mine) continue;
        const a = clamp((st.dark[i] - lo) / (hi - lo), 0, 1);
        const t = 4 * (y * gw + x);
        rgba[t] = st.rgba[4 * i]; rgba[t + 1] = st.rgba[4 * i + 1]; rgba[t + 2] = st.rgba[4 * i + 2];
        rgba[t + 3] = Math.round(255 * a * a * (3 - 2 * a));
        if (a > 0.85) { cr.push(rgba[t]); cg.push(rgba[t + 1]); cb.push(rgba[t + 2]); }
      }
    }
    const ink: [number, number, number] = cr.length ? [Math.round(median(cr)), Math.round(median(cg)), Math.round(median(cb))] : [30, 40, 120];
    // paper-tinted edge pixels take the ink colour: only their transparency carries the edge
    for (let t = 0; t < rgba.length; t += 4) if (rgba[t + 3] && rgba[t + 3] < 200) { rgba[t] = ink[0]; rgba[t + 1] = ink[1]; rgba[t + 2] = ink[2]; }

    const ch = s.place.ch;
    const mkJoint = (px: number, py: number, kind: Joint['kind'], conf: number, inward: 1 | -1): Joint | null => {
      const start = nearestSkel(px, py, idx, kind === 'cut' ? 5 : 2.5);
      if (start < 0) return null;
      const pts = arm(start, idx);
      const tg = tangent(px, py, pts);
      if (!tg) return null;
      // a joint must lead into the letter: to the right on entry, to the left on exit
      if (kind !== 'cut' && tg.tx * inward < 0.15) return null;
      return {
        kind, level: levelOf(py), p0: [px - gx, py - gy], p1: [px - gx + L * tg.tx, py - gy + L * tg.ty],
        width: Math.max(1, 2 * dt[Math.round(py) * W + Math.round(px)] || sw), conf: Math.round(100 * conf * clamp(tg.straight, 0.2, 1)) / 100,
      };
    };
    const endJoint = (entry: boolean): Joint | null => {
      const level = entry ? entryLevel(ch) : exitLevel(ch);
      const ty = level === 'high' ? baseY - 0.9 * xh : baseY - 0.12 * xh;
      const tx = entry ? x0 : x1;
      let best = -1, bs = Infinity;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (!skFull[i] || owner[i] !== idx) continue;
        if (neighbours(skFull, W, H, i).filter((q) => owner[q] === idx).length !== 1) continue;
        const rel = (x - x0) / Math.max(1, x1 - x0);
        if (entry ? rel > 0.5 : rel < 0.5) continue;
        if (y < baseY - 1.35 * xh || y > baseY + 0.3 * xh) continue;
        const sc = Math.abs(x - tx) + 1.5 * Math.abs(y - ty);
        if (sc < bs) { bs = sc; best = i; }
      }
      if (best >= 0) {
        const j = mkJoint(best % W, Math.floor(best / W), 'end', 0.6, entry ? 1 : -1);
        if (j) return j;
      }
      const p0: [number, number] = [tx - gx, ty - gy];
      return { kind: 'virtual', level, p0, p1: [p0[0] + (entry ? L : -L), p0[1]], width: sw, conf: 0.2 };
    };
    let entry: Joint | null = null;
    let exit: Joint | null = null;
    if (isJoining(ch)) {
      if (s.leftCut) entry = mkJoint(s.leftCut.px, s.leftCut.py, 'cut', 1, 1);
      if (s.rightCut) exit = mkJoint(s.rightCut.px, s.rightCut.py, 'cut', 1, -1);
      if (!entry && !isUpper(ch)) entry = endJoint(true);
      if (!exit) exit = endJoint(false);
    }
    const meta: GlyphMeta = {
      schema: 2, id: '', char: ch, variant: 0, position: s.position, prev: s.prev, next: s.next,
      width: gw, height: gh, bbox: [x0 - gx, y0 - gy, x1 - gx + 1, y1 - gy + 1],
      baseline: baseY - gy, x_height: Math.round(xh * 10) / 10, stroke_width: Math.round(sw * 10) / 10, slant: st.slant, ink_rgb: ink,
      entry, exit,
      source: { file: opts.file, line: st.lineId, index: s.place.index, px_per_mm: opts.pxPerMm ? opts.pxPerMm * st.scale : null },
      quality: { cost: Math.round(s.place.cost * 100) / 100, auto: s.place.cost <= (opts.autoCost ?? 3) },
      enabled: true, checked_by_user: false,
    };
    glyphs.push({ meta, rgba });
  });
  return glyphs;
}
