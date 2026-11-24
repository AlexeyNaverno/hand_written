import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHEET,
  PAGE_MM,
  cleanText,
  connectionBetween,
  glyphScale,
  layoutPages,
  pressureAt,
  radiusFactor,
  tokenize,
  type PlacedGlyph,
  type SheetSettings,
} from '../src/core/sheet';
import { METRICS, type GlyphData } from '../src/core/glyph';

const glyph = (char: string): GlyphData => ({
  char,
  metrics: { ...METRICS },
  path: [
    { x: 180, y: 420 },
    { x: 200, y: 300 },
    { x: 240, y: 300 },
    { x: 260, y: 420 },
  ],
  anchors: {
    entry: { main: { x: 180, y: 420 }, handle: { x: 190, y: 380 } },
    exit: { main: { x: 260, y: 420 }, handle: { x: 255, y: 400 } },
  },
});

const library = (chars: string, variants = 1): Map<string, GlyphData[]> => {
  const map = new Map<string, GlyphData[]>();
  for (const ch of chars) map.set(ch, Array.from({ length: variants }, () => glyph(ch)));
  return map;
};

const settings = (patch: Partial<SheetSettings> = {}): SheetSettings => ({ ...DEFAULT_SHEET, ...patch });

describe('tokenizer (система last_d.py)', () => {
  it('разбирает заголовок, подзаголовок и абзацы', () => {
    const tokens = tokenize('**Глава 1**\n*Введение*\nПривет мир\nвторой абзац');
    expect(tokens.map((t) => t.type)).toEqual([
      'heading',
      'paragraph',
      'subheading',
      'paragraph',
      'word',
      'word',
      'paragraph',
      'word',
      'word',
    ]);
    const heading = tokens[0];
    expect(heading.type === 'heading' && heading.text).toBe('Глава 1');
  });

  it('звёздочка вне маркера остаётся в слове', () => {
    const tokens = tokenize('2 * 2');
    expect(tokens.filter((t) => t.type === 'word').map((t) => (t.type === 'word' ? t.text : ''))).toEqual(['2', '*', '2']);
  });

  it('cleanText выбрасывает символы без глифов, но сохраняет пробелы, переводы строк и *', () => {
    const available = new Set(['а', 'б', 'д']);
    expect(cleanText('абв **гд**\n', available)).toBe('аб **д**\n');
  });
});

describe('раскладка листа', () => {
  it('ставит слова в строку и переносит на новую страницу при переполнении', () => {
    const text = Array.from({ length: 40 }, () => 'аб аб аб').join('\n');
    const res = layoutPages(tokenize(text), library('аб'), settings());
    expect(res.pages.length).toBeGreaterThan(1);
    const [w, h] = PAGE_MM.A5;
    for (const page of res.pages) {
      expect(page.widthMm).toBe(w);
      expect(page.heightMm).toBe(h);
      for (const g of page.glyphs) {
        expect(g.xMm).toBeGreaterThan(0);
        expect(g.xMm).toBeLessThan(w);
        expect(g.baselineMm).toBeGreaterThan(0);
        expect(g.baselineMm).toBeLessThan(h);
      }
    }
  });

  it('соединяет соседние русские буквы внутри слова кривой Безье', () => {
    const res = layoutPages(tokenize('аб'), library('аб'), settings(), () => 0.5);
    const page = res.pages[0];
    expect(page.glyphs.length).toBe(2);
    expect(page.connections.length).toBe(1);
    const pts = page.connections[0].pts;
    expect(pts.length).toBe(25);
    const first = page.glyphs[0];
    const expectedStart = {
      x: first.xMm + (first.glyph.anchors.exit.main.x - first.ox) * first.scale,
      y: first.baselineMm - (METRICS.baselineY - first.glyph.anchors.exit.main.y) * first.scale,
    };
    expect(pts[0].x).toBeCloseTo(expectedStart.x, 5);
    expect(pts[0].y).toBeCloseTo(expectedStart.y, 5);
  });

  it('не соединяет буквы через пробел и латиницу', () => {
    const res = layoutPages(tokenize('аб вг ab'), library('абвгab'), settings(), () => 0.5);
    // по одной связи в каждом русском слове, латиница не связывается
    expect(res.pages[0].connections.length).toBe(2);
  });

  it('сообщает об отсутствующих глифах', () => {
    const res = layoutPages(tokenize('абв'), library('аб'), settings());
    expect(res.missing).toEqual(['в']);
  });

  it('заголовок центрируется, подзаголовок с двойным отступом', () => {
    const res = layoutPages(tokenize('*Под*\nаб'), library('абПдо'), settings({ lowerMm: 4, indentMm: 10 }), () => 0.5);
    const page = res.pages[0];
    const [w] = PAGE_MM.A5;
    const headingGlyph = page.glyphs[0];
    // первая буква заголовка начинается правее левого поля
    expect(headingGlyph.xMm).toBeGreaterThan(settings().marginLeftMm + settings().bindingWidthMm);
    const headingRight = page.glyphs
      .slice(0, 3)
      .reduce((acc, g) => Math.max(acc, g.xMm), 0);
    expect(headingRight).toBeLessThan(w);
  });

  it('учитывает переплёт: рабочая ширина меньше при переплёте слева', () => {
    const withBinding = layoutPages(tokenize('аб '.repeat(50)), library('аб'), settings({ bindingWidthMm: 20, alternateBinding: false }));
    const noBinding = layoutPages(tokenize('аб '.repeat(50)), library('аб'), settings({ bindingWidthMm: 0, alternateBinding: false }));
    expect(withBinding.pages.length).toBeGreaterThanOrEqual(noBinding.pages.length);
  });
});

describe('пропорции букв и пера', () => {
  it('строчные считаются по x-высоте, заглавные — по высоте над базовой линией', () => {
    const g = glyph('а');
    const lower = glyphScale(g, 'а', settings({ lowerMm: 4, upperMm: 6 }));
    expect(lower).toBeCloseTo(4 / (METRICS.baselineY - METRICS.topLineY), 6);
    const upperGlyph: GlyphData = { ...g, path: [{ x: 180, y: 60 }, { x: 200, y: 400 }] };
    const upper = glyphScale(upperGlyph, 'А', settings({ lowerMm: 4, upperMm: 6 }));
    expect(upper).toBeCloseTo(6 / (METRICS.baselineY - 60), 6);
  });

  it('кривая соединения заканчивается в точке входа следующей буквы', () => {
    const a: PlacedGlyph = { glyph: glyph('а'), char: 'а', xMm: 10, baselineMm: 30, scale: 0.02, ox: 180 };
    const b: PlacedGlyph = { glyph: glyph('б'), char: 'б', xMm: 14, baselineMm: 30, scale: 0.02, ox: 180 };
    const conn = connectionBetween(a, b);
    const end = conn.pts[conn.pts.length - 1];
    expect(end.x).toBeCloseTo(14, 6);
    expect(end.y).toBeCloseTo(30 - (METRICS.baselineY - 420) * 0.02, 6);
  });

  it('давление и толщина остаются в физичных пределах', () => {
    for (let i = 0; i <= 100; i++) {
      const p = pressureAt(i / 100, 1, 2);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(radiusFactor(p)).toBeGreaterThanOrEqual(0.6);
      expect(radiusFactor(p)).toBeLessThanOrEqual(1.4);
    }
    // на концах штриха перо приподнято
    expect(pressureAt(0, 1, 2)).toBeLessThan(0.05);
    expect(pressureAt(1, 1, 2)).toBeLessThan(0.05);
  });
});

describe('PDF-тайлы', () => {
  it('A5 при 1200x2400 режется на тайлы ≤2048 px и полностью покрывает страницу', async () => {
    const { planTiles } = await import('../src/core/render');
    const [w, h] = PAGE_MM.A5;
    const tiles = planTiles(w, h, 1200, 2400);
    let area = 0;
    for (const t of tiles) {
      expect(t.wMm * (1200 / 25.4)).toBeLessThanOrEqual(2048.5);
      expect(t.hMm * (2400 / 25.4)).toBeLessThanOrEqual(2048.5);
      expect(t.xMm).toBeGreaterThanOrEqual(0);
      expect(t.yMm).toBeGreaterThanOrEqual(0);
      expect(t.xMm + t.wMm).toBeLessThanOrEqual(w + 1e-9);
      expect(t.yMm + t.hMm).toBeLessThanOrEqual(h + 1e-9);
      area += t.wMm * t.hMm;
    }
    expect(area).toBeCloseTo(w * h, 6);
    // A5 при 1200x2400: тайл 43.3×21.7 мм => 4 колонки × 10 строк
    expect(tiles.length).toBe(40);
  });
});

describe('знаки препинания на листе', () => {
  it('при printPunct=false точки и запятые не печатаются', () => {
    const lib = library('аб.,');
    const withPunct = layoutPages(tokenize('аб, аб.'), lib, settings({ printPunct: true }), () => 0.5);
    const withoutPunct = layoutPages(tokenize('аб, аб.'), lib, settings({ printPunct: false }), () => 0.5);
    expect(withPunct.pages[0].glyphs.map((g) => g.char).filter((c) => c === ',' || c === '.')).toHaveLength(2);
    expect(withoutPunct.pages[0].glyphs.map((g) => g.char).filter((c) => c === ',' || c === '.')).toHaveLength(0);
  });
});
