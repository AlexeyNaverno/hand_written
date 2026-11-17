/** Draws the app icons (PNG) with the project's own PNG writer; run once: npx tsx tools/make-icons.mts */
import fs from 'node:fs';
import { encodePng } from '../src/core/png';

function icon(size: number): Uint8Array {
  const S = 4; // supersampling
  const n = size * S;
  const cov = new Float32Array(n * n * 2); // stroke coverage, line coverage
  const stamp = (cx: number, cy: number, r: number, ch: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) cov[2 * (y * n + x) + ch] = 1;
  };
  const k = n / 512;
  // a cursive "ш"-like stroke: three hooks
  const pts: [number, number][] = [];
  const seg = (p0: number[], p1: number[], p2: number[], p3: number[]) => {
    for (let i = 0; i <= 60; i++) { const t = i / 60, u = 1 - t; pts.push([u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]]); }
  };
  seg([96, 330], [136, 260], [166, 180], [192, 180]); seg([192, 180], [222, 180], [184, 330], [214, 330]);
  seg([214, 330], [240, 330], [266, 180], [298, 180]); seg([298, 180], [326, 180], [292, 330], [322, 330]);
  seg([322, 330], [344, 330], [374, 270], [416, 234]);
  for (const [x, y] of pts) stamp(x * k, y * k, 15 * k, 0);
  for (let x = 96; x <= 416; x += 1) stamp(x * k, 390 * k, 6 * k, 1);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, b = 0;
    for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) { a += cov[2 * ((y * S + yy) * n + x * S + xx)]; b += cov[2 * ((y * S + yy) * n + x * S + xx) + 1]; }
    a /= S * S; b /= S * S;
    const bg = [31, 58, 138], ln = [157, 180, 245];
    const t = 4 * (y * size + x);
    for (let c = 0; c < 3; c++) out[t + c] = Math.round((bg[c] * (1 - b) + ln[c] * b) * (1 - a) + 255 * a);
    out[t + 3] = 255;
  }
  return encodePng(out, size, size);
}
for (const s of [192, 512]) fs.writeFileSync(`public/icon-${s}.png`, icon(s));
console.log('icons written');
