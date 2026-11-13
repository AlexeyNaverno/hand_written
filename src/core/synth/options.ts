/** Layout and rendering settings. Kept apart from the engine so that the page can use them without loading OpenCV. */
export interface SynthOptions {
  dpi: number;
  pageWmm: number;
  pageHmm: number;
  marginLeftMm: number;
  marginRightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  /** Extra margin on the binding side, alternating between odd and even pages. */
  bindingMm: number;
  rowMm: number;
  /** Height of lowercase letters. */
  xHeightMm: number;
  /** Space between words in x-heights. */
  wordSpace: number;
  indentMm: number;
  seed: number;
  /** 0..1: how much the pen thickness changes between paragraphs. */
  pressureVar: number;
  /** 0..1: height of the artificial bump on connecting strokes. */
  bump: number;
  /** 0..1: natural irregularity of size, spacing and baseline. */
  jitter: number;
  /** Paragraph of one line with fewer words than this is a heading. */
  headingMaxWords: number;
  headingNoTrailingDot: boolean;
  /** Recolour the ink; null keeps the colours of the source photos. */
  inkColor: [number, number, number] | null;
}

export const DEFAULT_OPTIONS: SynthOptions = {
  dpi: 400,
  pageWmm: 148,
  pageHmm: 210,
  marginLeftMm: 8,
  marginRightMm: 8,
  marginTopMm: 5,
  marginBottomMm: 8,
  bindingMm: 14,
  rowMm: 5,
  xHeightMm: 2.3,
  wordSpace: 1.0,
  indentMm: 10,
  seed: 1,
  pressureVar: 0.6,
  bump: 0.6,
  jitter: 0.6,
  headingMaxWords: 5,
  headingNoTrailingDot: true,
  inkColor: null,
};
