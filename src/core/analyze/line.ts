/** A text line prepared for harvesting: strip, over-segmentation, words and what the recogniser read in them. */
import * as cv from '../cv';
import { CtcRecognizer, WordReading } from '../ocr/ctc';
import { RGBA } from '../types';
import { FrameEvidence } from './align';
import { PageAnalysis, TextLine } from './page';
import { Segmentation, segmentLine } from './segment';
import { LineStrip, extractStrip } from './strip';

export interface WordBox {
  /** Primitive range [p0, p1). */
  p0: number;
  p1: number;
  /** Crop rectangle in the strip. */
  x: number;
  y: number;
  w: number;
  h: number;
  reading?: WordReading;
}

export interface LineAnalysis {
  strip: LineStrip;
  seg: Segmentation;
  words: WordBox[];
  /** What the recogniser read (empty without a recogniser); the user corrects it. */
  text: string;
  frames: FrameEvidence[];
}

const WORD_GAP = 0.5;

function paperColour(st: LineStrip): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const step = Math.max(1, Math.floor((st.width * st.height) / 4000));
  for (let i = 0; i < st.width * st.height; i += step) {
    if (st.dark[i] > 0.05) continue;
    r.push(st.rgba[4 * i]); g.push(st.rgba[4 * i + 1]); b.push(st.rgba[4 * i + 2]);
  }
  const med = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 255);
  return [med(r), med(g), med(b)];
}

/** Bounding rectangle (strip coordinates) of the ink of primitives [p0, p1). */
export function wordRect(st: LineStrip, seg: Segmentation, p0: number, p1: number) {
  const xa = seg.primitives[p0].xa;
  const xb = seg.primitives[p1 - 1].xb;
  const { width: W, height: H, baseY, slant } = st;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const shift = slant * (y - baseY);
    const xs = Math.max(0, Math.floor(xa - shift));
    const xe = Math.min(W - 1, Math.ceil(xb - shift));
    for (let x = xs; x <= xe; x++) {
      if (!st.ink[y * W + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const pad = Math.round(0.12 * st.xh);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Word image for the recogniser, resampled once from the original photo at its own resolution
 * (the recogniser reads noticeably worse from an enlarged-then-reduced copy). Ink of neighbouring lines is painted over.
 */
export function wordCrop(img: RGBA, st: LineStrip, rect: { x: number; y: number; w: number; h: number }, paper: [number, number, number]) {
  const S = st.scale;
  const M = st.fromPage;
  const w = Math.max(2, Math.ceil(rect.w / S));
  const h = Math.max(2, Math.ceil(rect.h / S));
  const Mc = [M[0] / S, M[1] / S, (M[2] - rect.x) / S, M[3] / S, M[4] / S, (M[5] - rect.y) / S];
  const src = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const out = cv.warp(src, img.width, img.height, Mc, w, h, 'linear', 255, 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = 4 * (y * w + x);
      let hide = out[t + 3] < 255;
      if (!hide) {
        // neighbour's ink anywhere under this source pixel
        const sx0 = Math.round(rect.x + x * S);
        const sy0 = Math.round(rect.y + y * S);
        for (let dy = 0; dy < S && !hide; dy++) {
          for (let dx = 0; dx < S; dx++) {
            const xx = sx0 + dx;
            const yy = sy0 + dy;
            if (xx < st.width && yy < st.height && st.foreign[yy * st.width + xx]) { hide = true; break; }
          }
        }
      }
      if (hide) { out[t] = paper[0]; out[t + 1] = paper[1]; out[t + 2] = paper[2]; }
      out[t + 3] = 255;
    }
  }
  return { rgba: out, w, h };
}

export async function analyzeLine(img: RGBA, page: PageAnalysis, line: TextLine, ocr?: CtcRecognizer): Promise<LineAnalysis> {
  const strip = extractStrip(img, page, line);
  const seg = segmentLine(strip);
  const words: WordBox[] = [];
  const paper = paperColour(strip);
  let start = 0;
  for (let q = 0; q <= seg.primitives.length; q++) {
    const atEnd = q === seg.primitives.length;
    const b = atEnd ? null : seg.boundaries[seg.primitives[q].left];
    const isGap = atEnd || (q > start && b!.kind === 'gap' && b!.gap / strip.xh >= WORD_GAP);
    if (!isGap) continue;
    if (q > start) {
      const r = wordRect(strip, seg, start, q);
      if (r) words.push({ p0: start, p1: q, ...r });
    }
    start = q;
  }
  const frames: FrameEvidence[] = [];
  let text = '';
  if (ocr) {
    for (const wd of words) {
      const crop = wordCrop(img, strip, wd, paper);
      const reading = await ocr.read(crop.rgba, crop.w, crop.h);
      wd.reading = reading;
      const yMid = strip.baseY - 0.5 * strip.xh;
      for (let f = 0; f < reading.frames; f++) {
        // frame position: crop pixels are source pixels, the strip is `scale` times larger
        const x = wd.x + (f + 0.5) * reading.frameStep * strip.scale;
        frames.push({ xd: x + strip.slant * (yMid - strip.baseY), probs: reading.probs.subarray(f * reading.classes, (f + 1) * reading.classes) });
      }
      text += (text ? ' ' : '') + reading.text;
    }
    frames.sort((p, q) => p.xd - q.xd);
  }
  return { strip, seg, words, text, frames };
}
