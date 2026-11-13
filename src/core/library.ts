/**
 * Glyph library: one colour PNG (with transparency) plus one JSON per letter variant.
 * The JSON keeps the fields of the old desktop program (bbox, baseline, left_joint, right_joint) and adds
 * what is needed for joined writing.
 */
import { JoinLevel, entryLevel, exitLevel, isJoining, isUpper } from './charset';

export interface Joint {
  /** cut = measured on a real connecting stroke; end = natural stroke end; virtual = assigned by rule. */
  kind: 'cut' | 'end' | 'virtual';
  level: JoinLevel;
  /** Attachment point on the stroke centre line, PNG pixels. */
  p0: [number, number];
  /** Second point of the same stroke further inside the letter. Pen direction: p0→p1 on entry, p1→p0 on exit. */
  p1: [number, number];
  /** Stroke width at p0. */
  width: number;
  conf: number;
}

export type Position = 'initial' | 'medial' | 'final' | 'isolated';

export interface GlyphMeta {
  schema: 2;
  id: string;
  char: string;
  variant: number;
  position: Position;
  prev: string;
  next: string;
  width: number;
  height: number;
  /** Tight ink box inside the PNG: [x1, y1, x2, y2]. */
  bbox: [number, number, number, number];
  /** y of the writing line inside the PNG (inherited from the text line, not measured on the letter). */
  baseline: number;
  /** Height of lowercase letters in the source line, px. The single unit for scaling. */
  x_height: number;
  stroke_width: number;
  /** tan of the writing slant. */
  slant: number;
  ink_rgb: [number, number, number];
  entry: Joint | null;
  exit: Joint | null;
  left_joint?: [number, number];
  right_joint?: [number, number];
  source: { file: string; line: number; index: number; px_per_mm: number | null };
  /** cost: alignment cost; auto: accepted without the user; read/p: what the recogniser read in the cut-out letter. */
  quality: { cost: number; auto: boolean; read?: string; p?: number };
  enabled: boolean;
  checked_by_user: boolean;
}

export interface Glyph {
  meta: GlyphMeta;
  /** Straight-alpha RGBA, meta.width × meta.height. */
  rgba: Uint8Array;
}

/** Old-format JSON (bbox + baseline, optional joints) → new metadata. Missing values are estimated. */
export function upgradeLegacy(
  json: Record<string, unknown>,
  char: string,
  variant: number,
  width: number,
  height: number,
): GlyphMeta {
  if (json.schema === 2 && typeof json.char === 'string') {
    const m = json as unknown as GlyphMeta;
    return { ...m, width, height, variant: m.variant ?? variant, enabled: m.enabled !== false };
  }
  const bb = (Array.isArray(json.bbox) && json.bbox.length === 4 ? (json.bbox as number[]) : [0, 0, width, height]) as [number, number, number, number];
  const baseline = typeof json.baseline === 'number' ? json.baseline : bb[3];
  const bodyH = Math.max(4, baseline - bb[1]);
  // without a measured x-height: lowercase letters without ascenders are about one x-height tall
  const tall = isUpper(char) || /[0-9бвдф]/.test(char);
  const xh = tall ? bodyH / 1.6 : Math.min(bodyH, bb[3] - bb[1]);
  const sw = Math.max(1.5, xh / 9);
  const joint = (p: unknown, entry: boolean): Joint | null => {
    if (!Array.isArray(p) || p.length < 2 || !isJoining(char)) return null;
    const x = p[0] as number;
    const y = p[1] as number;
    const L = 2.5 * sw;
    return { kind: 'virtual', level: entry ? entryLevel(char) : exitLevel(char), p0: [x, y], p1: [entry ? x + L : x - L, y], width: sw, conf: 0.3 };
  };
  return {
    schema: 2,
    id: '',
    char,
    variant,
    position: 'isolated',
    prev: '',
    next: '',
    width,
    height,
    bbox: bb,
    baseline,
    x_height: xh,
    stroke_width: sw,
    slant: 0,
    ink_rgb: [30, 40, 120],
    entry: joint(json.left_joint, true),
    exit: joint(json.right_joint, false),
    left_joint: Array.isArray(json.left_joint) ? (json.left_joint as [number, number]) : undefined,
    right_joint: Array.isArray(json.right_joint) ? (json.right_joint as [number, number]) : undefined,
    source: { file: 'legacy', line: 0, index: 0, px_per_mm: null },
    quality: { cost: 0, auto: false },
    enabled: true,
    checked_by_user: true,
  };
}

/** JSON written next to the PNG: new fields plus the old ones. */
export function metaToJson(m: GlyphMeta): string {
  const out: Record<string, unknown> = { ...m };
  if (m.entry) out.left_joint = m.entry.p0;
  if (m.exit) out.right_joint = m.exit.p0;
  return JSON.stringify(out, null, 1);
}
