/** Minimal PNG writer (8-bit RGBA) so that the core does not depend on a canvas. */
import { unzlibSync, zlibSync } from 'fflate';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter 1 (Sub) compresses smooth strokes better than no filter
    const o = y * (stride + 1);
    raw[o] = 1;
    const s = y * stride;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (rgba[s + x] - (x >= 4 ? rgba[s + x - 4] : 0)) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------------------------------------------------------------- reader


/** Reads non-interlaced 8-bit PNG files (grey, RGB, palette, with or without alpha) into straight RGBA. */
export function decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('Не PNG-файл');
  let pos = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= buf.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = buf[pos + 16]; ctype = buf[pos + 17]; interlace = buf[pos + 20];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('Поддерживаются только PNG 8 бит без чересстрочной развёртки');
  const channels = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
  const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) { all.set(d, o); o += d.length; }
  const raw = unzlibSync(all);
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const s = y * (stride + 1) + 1;
    const t = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[t + x - channels] : 0;
      const b = y > 0 ? px[t + x - stride] : 0;
      const c = x >= channels && y > 0 ? px[t + x - stride - channels] : 0;
      let v = raw[s + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[t + x] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (ctype === 0) { r = g = b = px[i]; if (trns && trns.length >= 2 && trns[1] === r) a = 0; }
    else if (ctype === 2) { r = px[3 * i]; g = px[3 * i + 1]; b = px[3 * i + 2]; }
    else if (ctype === 3) { const k = px[i]; r = palette![3 * k]; g = palette![3 * k + 1]; b = palette![3 * k + 2]; a = trns && k < trns.length ? trns[k] : 255; }
    else if (ctype === 4) { r = g = b = px[2 * i]; a = px[2 * i + 1]; }
    else { r = px[4 * i]; g = px[4 * i + 1]; b = px[4 * i + 2]; a = px[4 * i + 3]; }
    rgba[4 * i] = r; rgba[4 * i + 1] = g; rgba[4 * i + 2] = b; rgba[4 * i + 3] = a;
  }
  return { width, height, rgba };
}
