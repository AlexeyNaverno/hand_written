/** Basic image containers. All buffers are row-major. */
export interface RGBA {
  width: number;
  height: number;
  /** 4 bytes per pixel, straight (non-premultiplied) alpha. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface Bin {
  width: number;
  height: number;
  /** 0 or 1 per pixel. */
  data: Uint8Array;
}

export interface GrayF {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Point {
  x: number;
  y: number;
}

/** Deterministic random generator (mulberry32) so that layouts are reproducible by seed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Approximately normal, clipped to about ±3 sigma. */
  gauss(mean = 0, sigma = 1): number {
    const u = this.next() + this.next() + this.next() + this.next() - 2;
    return mean + sigma * u * 1.732;
  }
  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
