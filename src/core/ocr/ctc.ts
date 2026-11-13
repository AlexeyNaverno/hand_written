/**
 * Word recogniser with a CTC output (CRNN trained on Russian and English school handwriting).
 * Besides the text it returns per-frame letter probabilities, which is what locates letters inside a word.
 */
import * as cv from '../cv';

export interface CtcConfig {
  /** Characters in output order, after the service classes. */
  alphabet: string;
  /** Index of the first alphabet character among the output classes (blank = 0, out-of-vocabulary = 1). */
  firstChar: number;
  height: number;
  width: number;
  /** Input pixels per output frame. */
  stride: number;
  bgr: boolean;
}

export const AIFOREVER_NOTEBOOKS: CtcConfig = {
  alphabet: ' !"\'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPRSTVWY[\\]_abcdefghiklmnoprstuvwxyz|}ЁАБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяё’№',
  firstChar: 2,
  height: 64,
  width: 512,
  stride: 8,
  bgr: true,
};

/** The part of onnxruntime's API that is needed; the platform layer supplies the real session. */
export interface OrtLike {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
export interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { dims: readonly number[]; data: ArrayLike<number> }>>;
}

export interface WordReading {
  text: string;
  /** Mean probability of the emitted characters. */
  confidence: number;
  frames: number;
  classes: number;
  /** frames × classes probabilities. */
  probs: Float32Array;
  /** Crop pixels per frame (horizontal). */
  frameStep: number;
  /** Frame index of every emitted character. */
  spikes: number[];
}

export class CtcRecognizer {
  private index = new Map<string, number>();
  constructor(private ort: OrtLike, private session: SessionLike, readonly config: CtcConfig = AIFOREVER_NOTEBOOKS) {
    [...config.alphabet].forEach((ch, i) => this.index.set(ch, i + config.firstChar));
  }

  classOf(ch: string): number | undefined {
    return this.index.get(ch);
  }

  /** `rgba` is a crop with the word on a paper-coloured background. */
  async read(rgba: Uint8Array, w: number, h: number): Promise<WordReading> {
    const { height: IH, width: IW, stride, bgr, firstChar, alphabet } = this.config;
    const nw = Math.max(1, Math.min(IW, Math.floor((w * IH) / h)));
    const resized = cv.resize(rgba, w, h, nw, IH, IH < h ? 'area' : 'linear', 4);
    const t = new Float32Array(3 * IH * IW);
    const plane = IH * IW;
    for (let y = 0; y < IH; y++) {
      for (let x = 0; x < nw; x++) {
        const s = 4 * (y * nw + x);
        const o = y * IW + x;
        t[(bgr ? 2 : 0) * plane + o] = resized[s] / 255;
        t[plane + o] = resized[s + 1] / 255;
        t[(bgr ? 0 : 2) * plane + o] = resized[s + 2] / 255;
      }
    }
    const feeds: Record<string, unknown> = {};
    feeds[this.session.inputNames[0]] = new this.ort.Tensor('float32', t, [1, 3, IH, IW]);
    const out = (await this.session.run(feeds))[this.session.outputNames[0]];
    const dims = out.dims;
    const C = dims[dims.length - 1];
    const T = dims.length === 3 ? (dims[0] === 1 ? dims[1] : dims[0]) : dims[0];
    const used = Math.min(T, Math.ceil(nw / stride) + 1);
    const probs = new Float32Array(used * C);
    for (let f = 0; f < used; f++) {
      let mx = -Infinity;
      for (let c = 0; c < C; c++) mx = Math.max(mx, out.data[f * C + c]);
      let sum = 0;
      for (let c = 0; c < C; c++) sum += Math.exp(out.data[f * C + c] - mx);
      for (let c = 0; c < C; c++) probs[f * C + c] = Math.exp(out.data[f * C + c] - mx) / sum;
    }
    let text = '';
    let prev = -1;
    let acc = 0;
    const spikes: number[] = [];
    for (let f = 0; f < used; f++) {
      let bi = 0;
      for (let c = 1; c < C; c++) if (probs[f * C + c] > probs[f * C + bi]) bi = c;
      if (bi !== prev && bi >= firstChar && bi - firstChar < alphabet.length) {
        text += [...alphabet][bi - firstChar];
        acc += probs[f * C + bi];
        spikes.push(f);
      }
      prev = bi;
    }
    return { text, confidence: spikes.length ? acc / spikes.length : 0, frames: used, classes: C, probs, frameStep: (stride * w) / nw, spikes };
  }
}
