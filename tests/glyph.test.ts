import { describe, expect, it } from 'vitest';
import { ALL_CHARS, GROUPS, fileStem, parseStem } from '../src/core/charset';
import {
  batchSlots,
  buildQueue,
  fieldMm,
  mmToPx,
  slotId,
  smoothPoints,
  strokeToGlyph,
  autoDetectAnchors,
  ANCHOR_OFFSET,
  METRICS,
  type Point,
} from '../src/core/glyph';
import { buildZip, buildZipEntries, completeness } from '../src/core/zip';
import type { GlyphData } from '../src/core/glyph';

const line = (n: number): Point[] => Array.from({ length: n }, (_, i) => ({ x: i * 3, y: 100 + i }));

describe('charset', () => {
  it('covers 151 symbols without duplicates', () => {
    expect(ALL_CHARS.length).toBe(151);
    expect(new Set(ALL_CHARS).size).toBe(151);
    expect(GROUPS.map((g) => g.chars.length)).toEqual([33, 33, 26, 26, 10, 14, 9]);
  });

  it('fileStem/parseStem round-trip for every symbol and variant 1..4', () => {
    for (const ch of ALL_CHARS) {
      for (let v = 1; v <= 4; v++) {
        const stem = fileStem(ch, v);
        expect(stem).not.toMatch(/[\\/:*?"<>|]/);
        expect(parseStem(stem)).toEqual({ char: ch, variant: v });
      }
    }
  });

  it('uses the documented naming scheme', () => {
    expect(fileStem('а', 1)).toBe('а_1');
    expect(fileStem('А', 2)).toBe('загл_а_2');
    expect(fileStem('a', 3)).toBe('lat_a_3');
    expect(fileStem('Z', 4)).toBe('lat_upper_z_4');
    expect(fileStem('5', 1)).toBe('digit_5_1');
    expect(fileStem('.', 2)).toBe('точка_2');
    expect(fileStem('«', 1)).toBe('левая_ёлочка_1');
  });
});

describe('glyph processing (same principles as the HTML editor)', () => {
  it('smoothPoints keeps endpoints and length', () => {
    const pts = line(10);
    const sm = smoothPoints(pts);
    expect(sm.length).toBe(10);
    expect(sm[0]).toEqual(pts[0]);
    expect(sm[9]).toEqual(pts[9]);
    expect(sm[5].x).toBeCloseTo((pts[4].x + pts[5].x + pts[6].x) / 3);
  });

  it('уровни: верх и низ центральной клетки, строчная высота = 1/3 поля', () => {
    expect(METRICS.topLineY).toBe(200);
    expect(METRICS.baselineY).toBe(400);
    expect(METRICS.baselineY - METRICS.topLineY).toBe(600 / 3);
  });

  it('autoDetectAnchors: точки чуть левее/правее крайних точек штриха', () => {
    const path = line(101).map((p) => ({ x: p.x + 200, y: p.y }));
    const a = autoDetectAnchors(path)!;
    expect(a.entry.main.x).toBeCloseTo(200 - ANCHOR_OFFSET, 5);
    expect(a.entry.handle.x).toBeCloseTo(200 - ANCHOR_OFFSET * 2, 5);
    expect(a.entry.main.y).toBe(path[0].y);
    expect(a.exit.main.x).toBeCloseTo(path[100].x + ANCHOR_OFFSET, 5);
    expect(a.exit.handle.x).toBeCloseTo(path[100].x + ANCHOR_OFFSET * 2, 5);
    expect(a.exit.main.y).toBe(path[100].y);
  });

  it('auto-точки не выходят за холст у краёв', () => {
    const path = line(20);
    const a = autoDetectAnchors(path)!;
    expect(a.entry.main.x).toBeGreaterThanOrEqual(0);
    expect(a.entry.handle.x).toBeGreaterThanOrEqual(0);
    const right = line(20).map((p) => ({ x: p.x + 580, y: p.y }));
    const b = autoDetectAnchors(right)!;
    expect(b.exit.main.x).toBeLessThanOrEqual(600);
    expect(b.exit.handle.x).toBeLessThanOrEqual(600);
  });

  it('strokeToGlyph rejects too-short strokes and produces the HTML format', () => {
    expect(strokeToGlyph('б', line(5))).toBeNull();
    const g = strokeToGlyph('б', line(50))!;
    expect(g.char).toBe('б');
    expect(g.metrics).toEqual({ topLineY: 200, baselineY: 400, canvasWidth: 600, canvasHeight: 600 });
    expect(g.path.length).toBe(50);
    const minX = Math.min(...g.path.map((p) => p.x));
    const maxX = Math.max(...g.path.map((p) => p.x));
    expect(g.anchors.entry.main.x).toBeCloseTo(Math.max(0, minX - ANCHOR_OFFSET), 5);
    expect(g.anchors.exit.main.x).toBeCloseTo(Math.min(600, maxX + ANCHOR_OFFSET), 5);
    // JSON round-trip keeps the exact shape of the HTML export
    const parsed = JSON.parse(JSON.stringify(g));
    expect(Object.keys(parsed).sort()).toEqual(['anchors', 'char', 'metrics', 'path']);
  });

  it('long strokes are resampled to at most 250 points, endpoints kept', () => {
    const g = strokeToGlyph('а', line(2000))!;
    expect(g.path.length).toBeLessThanOrEqual(250);
    expect(g.path[0].x).toBe(0);
    expect(g.path[g.path.length - 1].x).toBe(5997);
  });

  it('mm scale: 5 mm cell, 3x3 field = 15 mm', () => {
    expect(fieldMm(5, 3)).toBe(15);
    expect(mmToPx(15)).toBeCloseTo(56.7, 1);
  });
});

describe('queue and export', () => {
  const groupOf = (ch: string) => {
    const g = GROUPS.find((gr) => gr.chars.includes(ch));
    return { id: g!.id, title: g!.title };
  };

  it('queue is automatic: every char x variants, in order', () => {
    const q = buildQueue(ALL_CHARS, groupOf, 4);
    expect(q.length).toBe(151 * 4);
    expect(q[0]).toMatchObject({ char: 'а', variant: 1 });
    expect(q[1]).toMatchObject({ char: 'а', variant: 2 });
    expect(q[4]).toMatchObject({ char: 'б', variant: 1 });
    expect(q[q.length - 1].variant).toBe(4);
    expect(q.every((s, i) => s.index === i)).toBe(true);
  });

  it('batchSlots slices the queue by cursor and batch size', () => {
    const q = buildQueue(ALL_CHARS, groupOf, 4);
    expect(batchSlots(q, 0, 12).length).toBe(12);
    expect(batchSlots(q, 12, 12)[0].index).toBe(12);
    expect(batchSlots(q, q.length - 5, 12).length).toBe(5);
  });

  it('completeness counts filled slots', () => {
    const q = buildQueue(['а', 'б'], groupOf, 4);
    const glyphs: Record<string, GlyphData> = {
      [slotId('а', 1)]: strokeToGlyph('а', line(20))!,
    };
    const c = completeness(q, glyphs);
    expect(c.total).toBe(8);
    expect(c.filled).toBe(1);
    expect(c.complete).toBe(false);
    expect(c.missing[0]).toMatchObject({ char: 'а', variant: 2 });
  });

  it('zip entries: symbols/*.json + manifest.json + README.txt, names parse back', () => {
    const q = buildQueue(['а', 'А', 'a', '5', '.'], groupOf, 4);
    const glyphs: Record<string, GlyphData> = {};
    for (const s of q) glyphs[slotId(s.char, s.variant)] = strokeToGlyph(s.char, line(20))!;
    const entries = buildZipEntries(q, glyphs);
    const jsons = entries.filter((e) => e.name.startsWith('symbols/'));
    expect(jsons.length).toBe(20);
    expect(entries.some((e) => e.name === 'manifest.json')).toBe(true);
    expect(entries.some((e) => e.name === 'README.txt')).toBe(true);
    for (const e of jsons) {
      const stem = e.name.slice('symbols/'.length, -'.json'.length);
      const parsed = parseStem(stem);
      expect(parsed).not.toBeNull();
      const data = JSON.parse(new TextDecoder().decode(e.data));
      expect(data.char).toBe(parsed!.char);
    }
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data));
    expect(manifest.symbols.length).toBe(20);
    expect(manifest.symbols[0]).toMatchObject({ file: 'а_1.json', char: 'а', variant: 1 });

    const zip = buildZip(q, glyphs);
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    expect(zip.length).toBeGreaterThan(1000);
  });
});
