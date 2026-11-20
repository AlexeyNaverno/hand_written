import { describe, expect, it } from 'vitest';
import { rectifyQuad, vectorizeGlyph } from '../src/core/worksheet';

describe('worksheet perspective selection', () => {
  it('rejects crossed corners before starting the image warp', async () => {
    await expect(rectifyQuad(new Uint8Array(4 * 4 * 4), 4, 4, [[0, 0], [1, 1], [1, 0], [0, 1]])).rejects.toThrow(/convex/);
  });
});

describe('worksheet glyph vectors', () => {
  it('traces a simple raster stroke while preserving explicit unknown pen direction', () => {
    const w = 7, h = 7;
    const rgba = new Uint8Array(w * h * 4);
    for (const [x, y] of [[2, 1], [2, 2], [2, 3], [2, 4], [2, 5]]) {
      const i = 4 * (y * w + x);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    const vector = vectorizeGlyph(rgba, w, h);
    expect(vector.schema).toBe(1);
    expect(vector.direction).toBe('unknown');
    expect(vector.strokes.length).toBe(1);
    expect(vector.strokes[0].points.length).toBeGreaterThanOrEqual(2);
    expect(vector.strokes[0].points.every(([x, y]) => x >= 0 && x < w && y >= 0 && y < h)).toBe(true);
  });

  it('retains separate vector components for disconnected marks', () => {
    const w = 12, h = 8;
    const rgba = new Uint8Array(w * h * 4);
    for (const [x, y] of [[2, 2], [3, 2], [4, 2], [8, 5], [8, 6]]) {
      const i = 4 * (y * w + x);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 20;
      rgba[i + 3] = 255;
    }
    const vector = vectorizeGlyph(rgba, w, h);
    expect(vector.strokes.length).toBe(2);
  });

  it('returns an empty, low-confidence vector for a blank transparent raster', () => {
    const vector = vectorizeGlyph(new Uint8Array(8 * 8 * 4), 8, 8);
    expect(vector.strokes).toEqual([]);
    expect(vector.confidence).toBe(0);
  });
});
