/**
 * Генератор рукописного листа (вкладка «Лист»).
 *
 * Раскладка текста — по системе last_d.py: токенизатор с заголовками
 * **...** и подзаголовками *...*, перенос слов по строкам и страницам,
 * переплёт слева/справа с чередованием, абзацный отступ, сжатие длинных
 * слов под ширину строки.
 *
 * Отличие от last_d.py: данные — векторные JSON-глифы (не PNG), поэтому
 * русские буквы внутри слова связываются не прямой линией, а кубической
 * кривой Безье через векторы входа/выхода: от exit.main одной буквы
 * (с касательной exit.handle) к entry.main следующей (с касательной
 * entry.handle). Экспорт — только PDF, страницы генерируются последовательно.
 */
import { scriptOf } from './charset';
import { CANVAS_W, METRICS, type GlyphData, type Point } from './glyph';

export interface SheetSettings {
  text: string;
  lowerMm: number;
  upperMm: number;
  rowHeightMm: number;
  indentMm: number;
  pageFormat: 'A5' | 'A4';
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  bindingSide: 'left' | 'right';
  alternateBinding: boolean;
  bindingWidthMm: number;
  shiftMm: number;
  maxLinesPerPage: number;
  printPunct: boolean;
  inkColor: string;
  /** Толщина пера, мм (номинальный диаметр штампа). */
  penThicknessMm: number;
  /** Смягчение края чернил: 0 — резкий край, 1 — сильное расплывание. */
  penSoftness: number;
  /** Неравномерность: джиттер толщины и мягкости вдоль штриха. */
  penUnevenness: number;
  dpiX: number;
  dpiY: number;
}

export const DEFAULT_SHEET: SheetSettings = {
  text: '**Глава 1**\n*Введение*\nВот уже несколько лет я постоянно читаю один и тот же роман.\nКогда я заболел, ко мне пришел врач. Он выписал мне лекарство и сказал: "Принимайте по одной таблетке три раза в день".\nЯ спросил: "А что это за лекарство?" Он ответил: "Это очень эффективное средство".\nЯ поблагодарил его и пошел в аптеку. Там была огромная очередь. Я простоял два часа.\nНаконец, я получил лекарство и пошел домой. Дома я выпил таблетку и лег спать.\nНаутро я почувствовал себя лучше. С тех пор я всегда пью это лекарство, когда болею.\nНо однажды случилось непредвиденное: лекарство закончилось, а аптека была закрыта.\nЯ решил попробовать народные средства: мед, лимон, имбирь. Они тоже помогли, но не так быстро.\nТогда я понял, что современная медицина — это великая вещь, но и природа дала нам много полезного.\nС тех пор я стараюсь вести здоровый образ жизни: занимаюсь спортом, правильно питаюсь, избегаю стрессов.\nИ теперь я болею гораздо реже. А если все же заболеваю, то сразу иду к врачу и выполняю все его рекомендации.\nТак что будьте здоровы и берегите себя!\n**Глава 2**\n*Продолжение*\nШирокая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.\nСъешь ещё этих мягких французских булок, да выпей же чаю.\nВ чащах юга жил бы цитрус? Да, но фальшивый экземпляр!\nАэрофотосъёмка ландшафта уже выявила земли богачей и процветающих крестьян.\n1234567890 .,;:()-',
  lowerMm: 4,
  upperMm: 6,
  rowHeightMm: 8,
  indentMm: 10,
  pageFormat: 'A5',
  marginTopMm: 5,
  marginBottomMm: 5,
  marginLeftMm: 10,
  marginRightMm: 10,
  bindingSide: 'left',
  alternateBinding: true,
  bindingWidthMm: 14,
  shiftMm: 0,
  maxLinesPerPage: 0,
  printPunct: true,
  inkColor: '#20208a',
  penThicknessMm: 0.35,
  penSoftness: 0.5,
  penUnevenness: 0.4,
  dpiX: 600,
  dpiY: 600,
};

export const PAGE_MM: Record<SheetSettings['pageFormat'], [number, number]> = {
  A5: [148, 210],
  A4: [210, 297],
};

// --- Токенизатор (как в last_d.py) ---

export type Token =
  | { type: 'word'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'subheading'; text: string }
  | { type: 'paragraph' };

export function cleanText(text: string, available: Set<string>): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\n' || ch === '*' || available.has(ch)) out += ch;
  }
  return out;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  let wordBuf = '';
  const flushWord = () => {
    if (wordBuf) {
      tokens.push({ type: 'word', text: wordBuf });
      wordBuf = '';
    }
  };
  let inside: 'heading' | 'subheading' | null = null;
  let markerContent = '';

  while (i < n) {
    const ch = text[i];
    if (inside) {
      const close = inside === 'heading' ? '**' : '*';
      if (text.startsWith(close, i)) {
        const after = i + close.length;
        if (markerContent && markerContent[markerContent.length - 1] !== ' ' && markerContent[markerContent.length - 1] !== '\n' && (after >= n || text[after] === ' ' || text[after] === '\n')) {
          flushWord();
          tokens.push({ type: inside, text: markerContent.trim() });
          i = after;
          inside = null;
          markerContent = '';
          continue;
        }
      }
      markerContent += ch;
      i++;
      continue;
    }
    if (ch === '*' && text[i + 1] === '*' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n')) {
      const afterOpen = i + 2;
      if (afterOpen < n && text[afterOpen] !== ' ' && text[afterOpen] !== '\n') {
        flushWord();
        inside = 'heading';
        markerContent = '';
        i += 2;
        continue;
      }
      wordBuf += '**';
      i += 2;
      continue;
    }
    if (ch === '*' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n')) {
      const afterOpen = i + 1;
      if (afterOpen < n && text[afterOpen] !== ' ' && text[afterOpen] !== '\n') {
        flushWord();
        inside = 'subheading';
        markerContent = '';
        i += 1;
        continue;
      }
      wordBuf += '*';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      flushWord();
      tokens.push({ type: 'paragraph' });
    } else if (ch === ' ') {
      flushWord();
    } else {
      wordBuf += ch;
    }
    i++;
  }
  flushWord();
  if (inside) tokens.push({ type: 'word', text: markerContent });
  return tokens;
}

// --- Размещение глифов ---

export interface PlacedGlyph {
  glyph: GlyphData;
  char: string;
  /** Левый край глифа, мм (от левого верхнего угла страницы). */
  xMm: number;
  /** Базовая линия строки, мм. */
  baselineMm: number;
  /** Масштаб: мм на логическую единицу холста. */
  scale: number;
  /** Левый край глифа в координатах холста — начало отсчёта по X. */
  ox: number;
}

export interface PlacedConnection {
  /** Точки кривой Безье в мм (от левого верхнего угла страницы). */
  pts: Point[];
}

export interface PlacedPage {
  glyphs: PlacedGlyph[];
  connections: PlacedConnection[];
  widthMm: number;
  heightMm: number;
}

export interface LayoutResult {
  pages: PlacedPage[];
  missing: string[];
}

const X_HEIGHT = METRICS.baselineY - METRICS.topLineY; // высота центральной клетки поля

/** Знаки, которые можно не печатать (настройка «Печатать знаки препинания»). */
const PUNCT_CHARS = new Set(['.', ',', ':', ';', '!', '?', '-', '—', '(', ')', '«', '»', '“', '”', '"', String.fromCharCode(39)]);

function glyphBBox(g: GlyphData): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of g.path) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Масштаб глифа: строчные/знаки — по x-высоте, заглавные и цифры — по высоте над базовой. */
export function glyphScale(g: GlyphData, ch: string, s: SheetSettings): number {
  const upper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
  const digit = /[0-9]/.test(ch);
  if (upper || digit) {
    const { minY } = glyphBBox(g);
    const h = Math.max(1, METRICS.baselineY - minY);
    return s.upperMm / h;
  }
  return s.lowerMm / X_HEIGHT;
}

export function cubicBezier(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

export function sampleBezier(p0: Point, c1: Point, c2: Point, p3: Point, steps = 24): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) pts.push(cubicBezier(p0, c1, c2, p3, i / steps));
  return pts;
}

const toMm = (p: Point, pg: PlacedGlyph): Point => ({
  x: pg.xMm + (p.x - pg.ox) * pg.scale,
  y: pg.baselineMm - (METRICS.baselineY - p.y) * pg.scale,
});

/** Кривая соединения двух соседних букв: exit.main → entry.main через handle-точки. */
export function connectionBetween(a: PlacedGlyph, b: PlacedGlyph): PlacedConnection {
  const p0 = toMm(a.glyph.anchors.exit.main, a);
  const c1 = toMm(a.glyph.anchors.exit.handle, a);
  const c2 = toMm(b.glyph.anchors.entry.handle, b);
  const p3 = toMm(b.glyph.anchors.entry.main, b);
  return { pts: sampleBezier(p0, c1, c2, p3) };
}

const isJoiningPair = (a: string, b: string) =>
  scriptOf(a) === 'cyr' && scriptOf(b) === 'cyr' && /[а-яёА-ЯЁ]/.test(a) && /[а-яёА-ЯЁ]/.test(b);

interface PreparedGlyph {
  glyph: GlyphData;
  char: string;
  scale: number;
  /** Смещение левого края глифа внутри холста. */
  ox: number;
  advance: number;
}

interface PreparedWord {
  glyphs: PreparedGlyph[];
  width: number;
  /** Индексы глифов внутри слова, участвующие в соединениях (пара i,i+1). */
  joinPairs: [number, number][];
}

export function layoutPages(
  tokens: Token[],
  library: Map<string, GlyphData[]>,
  s: SheetSettings,
  rng: () => number = Math.random,
): LayoutResult {
  const [pageW, pageH] = PAGE_MM[s.pageFormat];
  const missing = new Set<string>();
  const pages: PlacedPage[] = [];

  const prepareWord = (text: string, scaleMul = 1): PreparedWord | null => {
    const glyphs: PreparedGlyph[] = [];
    for (const ch of text) {
      if (!s.printPunct && PUNCT_CHARS.has(ch)) continue;
      const variants = library.get(ch);
      if (!variants || variants.length === 0) {
        missing.add(ch);
        continue;
      }
      const glyph = variants[Math.floor(rng() * variants.length)];
      const scale = glyphScale(glyph, ch, s) * scaleMul;
      const { minX, maxX } = glyphBBox(glyph);
      const advance = (maxX - minX) * scale + s.shiftMm;
      glyphs.push({ glyph, char: ch, scale, ox: minX, advance });
    }
    if (glyphs.length === 0) return null;
    const joinPairs: [number, number][] = [];
    for (let i = 0; i + 1 < glyphs.length; i++) {
      if (isJoiningPair(glyphs[i].char, glyphs[i + 1].char)) joinPairs.push([i, i + 1]);
    }
    return { glyphs, width: glyphs.reduce((acc, g) => acc + g.advance, 0), joinPairs };
  };

  const spaceW = s.lowerMm * 1.2;

  let page: PlacedPage = { glyphs: [], connections: [], widthMm: pageW, heightMm: pageH };
  let pageNumber = 0;
  let linesOnPage = 0;

  const bindingLeft = () => (s.alternateBinding ? pageNumber % 2 === 0 : true) ? s.bindingSide === 'left' : s.bindingSide !== 'left';
  const margins = () => {
    const left = bindingLeft();
    const x0 = s.marginLeftMm + (left ? s.bindingWidthMm : 0);
    const x1 = pageW - s.marginRightMm - (left ? 0 : s.bindingWidthMm);
    return { x0, x1, width: Math.max(10, x1 - x0) };
  };

  let baseline = s.marginTopMm + s.upperMm;
  let pendingIndent = true;
  let lineWords: { word: PreparedWord; x: number }[] = [];
  let lineX = margins().x0;

  const flushLine = () => {
    if (lineWords.length === 0) return;
    for (const { word, x } of lineWords) {
      let gx = x;
      const placed: PlacedGlyph[] = [];
      for (const pg of word.glyphs) {
        const placedGlyph: PlacedGlyph = {
          glyph: pg.glyph,
          char: pg.char,
          xMm: gx,
          baselineMm: baseline,
          scale: pg.scale,
          ox: pg.ox,
        };
        placed.push(placedGlyph);
        page.glyphs.push(placedGlyph);
        gx += pg.advance;
      }
      for (const [i, j] of word.joinPairs) page.connections.push(connectionBetween(placed[i], placed[j]));
    }
    lineWords = [];
    linesOnPage++;
  };

  const newLine = () => {
    flushLine();
    baseline += s.rowHeightMm;
    lineX = margins().x0;
    pendingIndent = false;
  };

  const newPage = () => {
    pages.push(page);
    page = { glyphs: [], connections: [], widthMm: pageW, heightMm: pageH };
    pageNumber++;
    linesOnPage = 0;
    baseline = s.marginTopMm + s.upperMm;
    lineX = margins().x0;
    pendingIndent = true;
  };

  const ensureLineFits = (): boolean => {
    if (baseline > pageH - s.marginBottomMm) {
      newPage();
      return true;
    }
    if (s.maxLinesPerPage > 0 && linesOnPage >= s.maxLinesPerPage && lineWords.length === 0) {
      newPage();
      return true;
    }
    return false;
  };

  const placeWord = (word: PreparedWord, centered = false, extraIndent = 0) => {
    const { width } = margins();
    let w = word;
    if (w.width > width) {
      const f = Math.max(0.4, width / w.width);
      w = {
        glyphs: w.glyphs.map((g) => ({ ...g, scale: g.scale * f, advance: g.advance * f })),
        width: w.width * f,
        joinPairs: w.joinPairs,
      };
    }
    const startX = centered ? margins().x0 + (width - w.width) / 2 : lineX + extraIndent;
    lineWords.push({ word: w, x: startX });
    lineX = startX + w.width + spaceW;
  };

  for (const tok of tokens) {
    if (tok.type === 'paragraph') {
      if (lineWords.length > 0) {
        newLine();
        baseline += s.rowHeightMm;
      } else {
        baseline += s.rowHeightMm;
      }
      pendingIndent = true;
      continue;
    }
    if (tok.type === 'heading' || tok.type === 'subheading') {
      if (lineWords.length > 0) newLine();
      ensureLineFits();
      const words = tok.text.split(/\s+/).filter(Boolean);
      const prepared = words.map((wd) => prepareWord(wd, tok.type === 'heading' ? 1.2 : 1)).filter((w): w is PreparedWord => w !== null);
      if (prepared.length === 0) continue;
      if (tok.type === 'heading') {
        // заголовок по центру, слова целиком; длинный заголовок переносится по словам
        let lineGroup: PreparedWord[] = [];
        const flushHeadingLine = () => {
          if (lineGroup.length === 0) return;
          const total = lineGroup.reduce((a, w) => a + w.width, 0) + spaceW * (lineGroup.length - 1);
          let hx = margins().x0 + Math.max(0, (margins().width - total) / 2);
          for (const w of lineGroup) {
            lineWords.push({ word: w, x: hx });
            hx += w.width + spaceW;
          }
          lineGroup = [];
          newLine();
        };
        for (const w of prepared) {
          const currentWidth =
            lineGroup.reduce((a, x) => a + x.width, 0) + spaceW * Math.max(0, lineGroup.length - 1);
          if (lineGroup.length > 0 && currentWidth + spaceW + w.width > margins().width) flushHeadingLine();
          lineGroup.push(w);
        }
        flushHeadingLine();
      } else {
        for (const w of prepared) placeWord(w, false, s.indentMm * 2);
        newLine();
      }
      pendingIndent = true;
      continue;
    }
    // обычное слово
    ensureLineFits();
    const word = prepareWord(tok.text);
    if (!word) continue;
    const { width } = margins();
    const avail = margins().x1 - lineX;
    if (word.width <= avail) {
      if (pendingIndent && lineWords.length === 0) {
        lineX += s.indentMm;
        pendingIndent = false;
      }
      placeWord(word);
    } else if (word.width <= width) {
      newLine();
      ensureLineFits();
      if (pendingIndent) {
        lineX += s.indentMm;
        pendingIndent = false;
      }
      placeWord(word);
    } else {
      if (lineWords.length > 0) newLine();
      ensureLineFits();
      placeWord(word); // placeWord сожмёт под ширину строки
      pendingIndent = false;
    }
  }
  flushLine();
  if (page.glyphs.length > 0 || pages.length === 0) pages.push(page);
  return { pages, missing: [...missing] };
}

// --- Модель пера: штампы вдоль штриха ---

export interface Stamp {
  x: number; // мм
  y: number; // мм
  r: number; // мм, радиус штампа
  alpha: number; // 0..1, плотность чернил
  soft: number; // 0..1, мягкость края
}

/** Давление вдоль штриха: гладкая псевдослучайная функция + затухание на концах. */
export function pressureAt(t: number, phase1: number, phase2: number): number {
  const taper = Math.min(1, Math.min(t, 1 - t) / 0.06);
  const p = 0.5 + 0.3 * Math.sin(2 * Math.PI * 3 * t + phase1) + 0.15 * Math.sin(2 * Math.PI * 7 * t + phase2);
  return Math.max(0.08, Math.min(1, p)) * taper;
}

/** Коэффициент ширины от давления: 0.6x–1.4x номинала (как у шариковой ручки). */
export function radiusFactor(p: number): number {
  return 0.6 + 0.8 * p;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strokeStamps(pts: Point[], s: SheetSettings, seed: number): Stamp[] {
  if (pts.length < 2) return [];
  const rng = mulberry32(seed);
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  const baseR = s.penThicknessMm / 2;
  const spacing = Math.max(0.06, baseR * 0.45);

  // длина и ресемплинг
  const segs: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(total);
  }
  if (total === 0) return [];
  const stamps: Stamp[] = [];
  const steps = Math.max(2, Math.ceil(total / spacing));
  for (let k = 0; k <= steps; k++) {
    const d = (k / steps) * total;
    // найти сегмент
    let idx = 1;
    while (idx < segs.length - 1 && segs[idx] < d) idx++;
    const segLen = segs[idx] - segs[idx - 1] || 1;
    const f = (d - segs[idx - 1]) / segLen;
    const x = pts[idx - 1].x + (pts[idx].x - pts[idx - 1].x) * f;
    const y = pts[idx - 1].y + (pts[idx].y - pts[idx - 1].y) * f;
    const t = k / steps;
    const p = pressureAt(t, phase1, phase2);
    const jitter = 1 + (rng() - 0.5) * s.penUnevenness;
    const r = Math.max(0.02, baseR * radiusFactor(p) * jitter);
    const alpha = 0.5 + 0.5 * p;
    // неравномерное смягчение: часть штампов с резким краем, часть с мягким
    const soft = Math.max(0, Math.min(1, s.penSoftness * (0.35 + 0.65 * rng())));
    stamps.push({ x, y, r, alpha, soft });
  }
  return stamps;
}

/** Все штампы страницы: штрихи букв + соединительные кривые. */
export function buildStamps(page: PlacedPage, s: SheetSettings): Stamp[] {
  const stamps: Stamp[] = [];
  let seed = 1;
  for (const pg of page.glyphs) {
    const pts = pg.glyph.path.map((p) => toMm(p, pg));
    stamps.push(...strokeStamps(pts, s, seed++ * 7919));
  }
  for (const conn of page.connections) {
    stamps.push(...strokeStamps(conn.pts, s, seed++ * 104729));
  }
  return stamps;
}

export { CANVAS_W };
