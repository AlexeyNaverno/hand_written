/**
 * OpenCV.js loader and thin typed-array wrappers.
 * Every wrapper copies data in, runs one OpenCV call and frees all Mats,
 * so callers never deal with WASM memory.
 */
import cvModule from '@techstark/opencv-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cv: any = null;
let loading: Promise<void> | null = null;

export function loadCV(): Promise<void> {
  if (cv) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      // The OpenCV.js module object is "thenable" in a way that never settles,
      // so it must not be awaited unless it is a real Promise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let m: any = cvModule;
      if (m instanceof Promise) {
        cv = await m;
        return;
      }
      if (!m.Mat && m.default && !(m.default instanceof Promise)) m = m.default;
      if (m instanceof Promise) {
        cv = await m;
        return;
      }
      if (!m.Mat) {
        await new Promise<void>((resolve) => {
          m.onRuntimeInitialized = () => resolve();
        });
      }
      cv = m;
    })();
  }
  return loading;
}

function need() {
  if (!cv) throw new Error('OpenCV is not loaded: call loadCV() first');
  return cv;
}

export type Interp = 'nearest' | 'linear' | 'cubic' | 'area';
const interpFlag = (i: Interp) => {
  const c = need();
  return i === 'nearest' ? c.INTER_NEAREST : i === 'linear' ? c.INTER_LINEAR : i === 'cubic' ? c.INTER_CUBIC : c.INTER_AREA;
};

function run1<T extends Uint8Array | Float32Array>(
  src: T,
  w: number,
  h: number,
  channels: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  op: (c: any, s: any, d: any) => void,
): T {
  const c = need();
  const isF = src instanceof Float32Array;
  const type = isF ? c.CV_32FC1 : channels === 4 ? c.CV_8UC4 : c.CV_8UC1;
  const s = c.matFromArray(h, w, type, src);
  const d = new c.Mat();
  try {
    op(c, s, d);
    return (isF ? new Float32Array(d.data32F) : new Uint8Array(d.data)) as T;
  } finally {
    s.delete();
    d.delete();
  }
}

/** Grey morphological closing with a rectangular kernel (kx × ky). */
export function closeU8(src: Uint8Array, w: number, h: number, kx: number, ky = kx): Uint8Array {
  return run1(src, w, h, 1, (c, s, d) => {
    const k = c.getStructuringElement(c.MORPH_RECT, new c.Size(kx, ky));
    c.morphologyEx(s, d, c.MORPH_CLOSE, k);
    k.delete();
  });
}

export function openU8(src: Uint8Array, w: number, h: number, kx: number, ky = kx): Uint8Array {
  return run1(src, w, h, 1, (c, s, d) => {
    const k = c.getStructuringElement(c.MORPH_RECT, new c.Size(kx, ky));
    c.morphologyEx(s, d, c.MORPH_OPEN, k);
    k.delete();
  });
}

export function dilateU8(src: Uint8Array, w: number, h: number, kx: number, ky = kx): Uint8Array {
  return run1(src, w, h, 1, (c, s, d) => {
    const k = c.getStructuringElement(c.MORPH_RECT, new c.Size(kx, ky));
    c.dilate(s, d, k);
    k.delete();
  });
}

export function erodeU8(src: Uint8Array, w: number, h: number, kx: number, ky = kx): Uint8Array {
  return run1(src, w, h, 1, (c, s, d) => {
    const k = c.getStructuringElement(c.MORPH_RECT, new c.Size(kx, ky));
    c.erode(s, d, k);
    k.delete();
  });
}

export function blur<T extends Uint8Array | Float32Array>(src: T, w: number, h: number, sigma: number): T {
  if (sigma <= 0) return src.slice() as T;
  return run1(src, w, h, 1, (c, s, d) => c.GaussianBlur(s, d, new c.Size(0, 0), sigma, sigma, c.BORDER_REPLICATE));
}

export function resize<T extends Uint8Array | Float32Array>(
  src: T,
  w: number,
  h: number,
  nw: number,
  nh: number,
  interp: Interp,
  channels = 1,
): T {
  return run1(src, w, h, channels, (c, s, d) => c.resize(s, d, new c.Size(nw, nh), 0, 0, interpFlag(interp)));
}

/** Affine warp, M = [a, b, tx, c, d, ty] maps source to destination coordinates. */
export function warp<T extends Uint8Array | Float32Array>(
  src: T,
  w: number,
  h: number,
  M: number[],
  nw: number,
  nh: number,
  interp: Interp,
  border: number,
  channels = 1,
): T {
  return run1(src, w, h, channels, (c, s, d) => {
    const m = c.matFromArray(2, 3, c.CV_64FC1, M);
    const bv = channels === 4 ? new c.Scalar(border, border, border, 0) : new c.Scalar(border);
    c.warpAffine(s, d, m, new c.Size(nw, nh), interpFlag(interp), c.BORDER_CONSTANT, bv);
    m.delete();
  });
}

export interface Components {
  count: number; // including background label 0
  labels: Int32Array;
  /** per label: x, y, w, h, area */
  stats: Int32Array;
}

export function components(bin: Uint8Array, w: number, h: number): Components {
  const c = need();
  const s = c.matFromArray(h, w, c.CV_8UC1, bin);
  const labels = new c.Mat();
  const stats = new c.Mat();
  const cent = new c.Mat();
  try {
    const count = c.connectedComponentsWithStats(s, labels, stats, cent, 8, c.CV_32S);
    return { count, labels: new Int32Array(labels.data32S), stats: new Int32Array(stats.data32S) };
  } finally {
    s.delete();
    labels.delete();
    stats.delete();
    cent.delete();
  }
}

/** Euclidean distance to the nearest zero pixel. */
export function distance(bin: Uint8Array, w: number, h: number): Float32Array {
  const c = need();
  const s = c.matFromArray(h, w, c.CV_8UC1, bin);
  const d = new c.Mat();
  try {
    c.distanceTransform(s, d, c.DIST_L2, 5);
    return new Float32Array(d.data32F);
  } finally {
    s.delete();
    d.delete();
  }
}
