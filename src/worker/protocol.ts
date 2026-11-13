/** Messages between the page and the worker that does all image processing. */
import type { GlyphMeta } from '../core/library';
import type { SynthOptions } from '../core/synth/options';

export interface LineInfo {
  index: number;
  text: string;
  /** Preview of the rectified line, straight RGBA. */
  preview: Uint8Array;
  width: number;
  height: number;
  baseY: number;
  xh: number;
}

export interface AnalyzeResult {
  lines: LineInfo[];
  skewDeg: number;
  ruling: string;
  pxPerMm: number | null;
  strokeWidth: number;
  xHeight: number;
}

export interface StoredGlyph {
  id: string;
  meta: GlyphMeta;
  png: Uint8Array;
}

export interface PreviewResult {
  rgba: Uint8Array;
  width: number;
  height: number;
  pages: number;
  missing: string[];
}

export interface CheckItem {
  line: number;
  word: string;
  read: string;
  ok: boolean;
}

export interface Commands {
  init: { args: Record<string, never>; result: { ok: true } };
  loadOcr: { args: { urls: string[]; ortPath: string }; result: { source: string } };
  analyze: { args: { rgba: Uint8Array; width: number; height: number; name: string }; result: AnalyzeResult };
  extract: { args: { line: number; text: string; widths: [string, number][] }; result: { glyphs: { meta: GlyphMeta; png: Uint8Array }[] } };
  setLibrary: { args: { glyphs: StoredGlyph[] }; result: { count: number } };
  importPng: { args: { png: Uint8Array; json: string | null; stem: string }; result: { meta: GlyphMeta; png: Uint8Array } | null };
  preview: { args: { text: string; options: Partial<SynthOptions>; page: number; dpi: number; paper: Paper }; result: PreviewResult };
  pdf: { args: { text: string; options: Partial<SynthOptions>; paper: Paper }; result: { bytes: Uint8Array; pages: number; missing: string[] } };
  check: { args: { text: string; options: Partial<SynthOptions>; page: number }; result: { items: CheckItem[] } };
}

/** Background drawn under the text: nothing, squared paper or ruled paper. */
export type Paper = 'blank' | 'squared' | 'ruled';

export type Cmd = keyof Commands;
export interface Request<C extends Cmd = Cmd> { id: number; cmd: C; args: Commands[C]['args'] }
export interface Response { id: number; result?: unknown; error?: string; progress?: { done: number; total: number; note?: string } }
