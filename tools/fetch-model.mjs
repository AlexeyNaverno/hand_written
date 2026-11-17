#!/usr/bin/env node
/**
 * Downloads the two neural models into public/models/ so that they ship with the app and work offline.
 *  - ocr_model.onnx: ai-forever/ReadingPipeline-notebooks (CRNN + CTC, Russian and English school notebooks), MIT.
 *  - det_model.onnx: PP-OCRv4 text detector (DBNet) from the rapidocr-onnxruntime wheel on PyPI, Apache-2.0.
 *    It marks the words on the page so that every row keeps its own baseline.
 * Both files are checked against known SHA-256 sums and are not committed to the repository (50 MB and 4.7 MB).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const OCR = {
  url: 'https://huggingface.co/ai-forever/ReadingPipeline-notebooks/resolve/main/ocr/ocr_model.onnx',
  sha256: 'cc5ada98e82336c3e229b78aff6758cda6c92e6ca2cae5d9118b3e447994fd6e',
  dest: path.resolve('public/models/ocr_model.onnx'),
};
const DET = {
  // the detector is taken straight out of the Apache-2.0 wheel published on PyPI
  url: 'https://files.pythonhosted.org/packages/ba/12/1e5497183bdbe782dbb91bad1d0d2297dba4d2831b2652657f7517bfc6df/rapidocr_onnxruntime-1.4.4-py3-none-any.whl',
  member: 'rapidocr_onnxruntime/models/ch_PP-OCRv4_det_infer.onnx',
  sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
  dest: path.resolve('public/models/det_model.onnx'),
};

async function download(url) {
  console.log('downloading', url);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** One stored/deflated member of a zip archive, without extra dependencies. */
function zipMember(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  let p = buf.readUInt32LE(eocd + 16);
  for (;;) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (entry === name) {
      const ln = buf.readUInt16LE(off + 26);
      const le = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + ln + le, off + 30 + ln + le + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`member not found in the archive: ${name}`);
}

function place(dest, buf, sum, what) {
  if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sum) {
    console.log(`${what} is already in place`);
    return;
  }
  if (sha(buf) !== sum) {
    console.error(`checksum mismatch: the downloaded ${what} is not the expected model`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`saved ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

place(OCR.dest, await download(OCR.url), OCR.sha256, 'recogniser');
place(DET.dest, zipMember(await download(DET.url), DET.member), DET.sha256, 'row detector');
