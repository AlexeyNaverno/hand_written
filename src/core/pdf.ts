/**
 * Minimal PDF writer: pages made of raster images with transparency (soft masks) and optional vector ruling.
 * PDF has no variable-width line, so every text line is a high-resolution transparent image placed on the page.
 */
import { zlibSync } from 'fflate';

export interface PdfImage {
  /** Straight-alpha RGBA. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Position and size on the page in millimetres, from the top-left corner. */
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

export interface PdfRule {
  x1: number; y1: number; x2: number; y2: number; // mm from the top-left corner
  rgb: [number, number, number];
  widthMm: number;
}

const MM = 72 / 25.4;
const enc = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const num = (v: number) => (Math.round(v * 1000) / 1000).toString();

export class PdfWriter {
  private parts: Uint8Array[] = [];
  private offsets: number[] = [0];
  private size = 0;
  private pageIds: number[] = [];
  private nextId = 3; // 1 = catalog, 2 = page tree

  constructor(private pageWmm: number, private pageHmm: number) {
    this.push(enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  }

  private push(b: Uint8Array) {
    this.parts.push(b);
    this.size += b.length;
  }

  private obj(id: number, dict: string, stream?: Uint8Array) {
    this.offsets[id] = this.size;
    if (stream) {
      this.push(enc(`${id} 0 obj\n<< ${dict} /Length ${stream.length} >>\nstream\n`));
      this.push(stream);
      this.push(enc('\nendstream\nendobj\n'));
    } else this.push(enc(`${id} 0 obj\n<< ${dict} >>\nendobj\n`));
  }

  addPage(images: PdfImage[], rules: PdfRule[] = []) {
    const H = this.pageHmm;
    let content = '';
    for (const r of rules) {
      content += `${num(r.rgb[0] / 255)} ${num(r.rgb[1] / 255)} ${num(r.rgb[2] / 255)} RG ${num(r.widthMm * MM)} w ` +
        `${num(r.x1 * MM)} ${num((H - r.y1) * MM)} m ${num(r.x2 * MM)} ${num((H - r.y2) * MM)} l S\n`;
    }
    const names: string[] = [];
    for (const im of images) {
      const n = im.width * im.height;
      const rgb = new Uint8Array(n * 3);
      const alpha = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const a = im.rgba[4 * i + 3];
        alpha[i] = a;
        if (a) { rgb[3 * i] = im.rgba[4 * i]; rgb[3 * i + 1] = im.rgba[4 * i + 1]; rgb[3 * i + 2] = im.rgba[4 * i + 2]; }
      }
      const maskId = this.nextId++;
      const imgId = this.nextId++;
      this.obj(maskId, `/Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, zlibSync(alpha, { level: 6 }));
      this.obj(imgId, `/Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask ${maskId} 0 R`, zlibSync(rgb, { level: 6 }));
      const name = `Im${imgId}`;
      names.push(`/${name} ${imgId} 0 R`);
      content += `q ${num(im.wMm * MM)} 0 0 ${num(im.hMm * MM)} ${num(im.xMm * MM)} ${num((H - im.yMm - im.hMm) * MM)} cm /${name} Do Q\n`;
    }
    const contentId = this.nextId++;
    this.obj(contentId, '/Filter /FlateDecode', zlibSync(enc(content), { level: 6 }));
    const pageId = this.nextId++;
    this.obj(pageId, `/Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.pageWmm * MM)} ${num(H * MM)}] /Resources << /XObject << ${names.join(' ')} >> >> /Contents ${contentId} 0 R`);
    this.pageIds.push(pageId);
  }

  finish(): Uint8Array[] {
    this.obj(1, '/Type /Catalog /Pages 2 0 R');
    this.obj(2, `/Type /Pages /Count ${this.pageIds.length} /Kids [${this.pageIds.map((p) => `${p} 0 R`).join(' ')}]`);
    const xref = this.size;
    let table = `xref\n0 ${this.nextId}\n0000000000 65535 f \n`;
    for (let i = 1; i < this.nextId; i++) table += `${(this.offsets[i] ?? 0).toString().padStart(10, '0')} 00000 n \n`;
    this.push(enc(`${table}trailer\n<< /Size ${this.nextId} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return this.parts;
  }
}
