#!/usr/bin/env node
/**
 * Downloads the handwriting recogniser into public/models/ so that it ships with the app and works offline.
 * Model: ai-forever/ReadingPipeline-notebooks (CRNN + CTC, trained on Russian and English school notebooks), MIT licence.
 * The file is checked against a known SHA-256 and is not committed to the repository (about 50 MB).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = 'https://huggingface.co/ai-forever/ReadingPipeline-notebooks/resolve/main/ocr/ocr_model.onnx';
const SHA256 = 'cc5ada98e82336c3e229b78aff6758cda6c92e6ca2cae5d9118b3e447994fd6e';
const dest = path.resolve('public/models/ocr_model.onnx');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === SHA256) {
  console.log('model is already in place');
  process.exit(0);
}
console.log('downloading', URL_);
const res = await fetch(URL_);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
if (sha(buf) !== SHA256) {
  console.error('checksum mismatch: the downloaded file is not the expected model');
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, buf);
console.log(`saved ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
