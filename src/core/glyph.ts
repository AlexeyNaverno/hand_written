/**
 * Формат глифа — тот же, что экспортировал Cursive Glyph Editor (ключевой HTML):
 *
 * {
 *   "char": "б",
 *   "metrics": { "topLineY": 200, "baselineY": 400, "canvasWidth": 600, "canvasHeight": 600 },
 *   "path": [ { "x": 10.5, "y": 20.1 }, ... ],
 *   "anchors": {
 *     "entry": { "main": {...}, "handle": {...} },
 *     "exit":  { "main": {...}, "handle": {...} }
 *   }
 * }
 *
 * Логический холст всегда 600x600 независимо от физического размера на экране:
 * настройка размера в миллиметрах меняет только отображение, сохранённые
 * координаты не пересчитываются.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Anchors {
  entry: { main: Point; handle: Point };
  exit: { main: Point; handle: Point };
}

export interface GlyphData {
  char: string;
  metrics: { topLineY: number; baselineY: number; canvasWidth: number; canvasHeight: number };
  path: Point[];
  anchors: Anchors;
}

export const CANVAS_W = 600;
export const CANVAS_H = 600;

/**
 * Уровни поля 3×3: верхняя линия — верх центральной клетки (1/3 высоты),
 * базовая — низ центральной клетки (2/3). Строчная буква вписывается
 * в центральную клетку, выносные элементы уходят в верхнюю и нижнюю.
 */
export const METRICS = {
  topLineY: CANVAS_H / 3,
  baselineY: (CANVAS_H * 2) / 3,
  canvasWidth: CANVAS_W,
  canvasHeight: CANVAS_H,
};

/** Насколько точки входа/выхода выносятся наружу от крайних точек штриха. */
export const ANCHOR_OFFSET = CANVAS_W * 0.04;

/** Штрих короче этого числа сырых точек отбрасывается (как в HTML: нужно > 5). */
export const MIN_RAW_POINTS = 6;
/** Длинный штрих прореживается до этого числа точек, чтобы не раздувать хранилище. */
export const MAX_PATH_POINTS = 250;

/** Сглаживание скользящим средним по трём точкам — дословно как в HTML-редакторе. */
export function smoothPoints(pts: Point[]): Point[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));
  const result: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || i === pts.length - 1) {
      result.push({ ...pts[i] });
    } else {
      result.push({
        x: (pts[i - 1].x + pts[i].x + pts[i + 1].x) / 3,
        y: (pts[i - 1].y + pts[i].y + pts[i + 1].y) / 3,
      });
    }
  }
  return result;
}

/**
 * Автоматические точки входа/выхода: main — чуть левее самой левой и чуть
 * правее самой правой точки штриха, на их высоте; handle — ещё на столько же
 * наружу, поэтому соединительная кривая выходит и входит горизонтально.
 */
export function autoDetectAnchors(path: Point[]): Anchors | null {
  if (path.length < 4) return null;
  let left = path[0];
  let right = path[0];
  for (const p of path) {
    if (p.x < left.x) left = p;
    if (p.x > right.x) right = p;
  }
  const d = ANCHOR_OFFSET;
  return {
    entry: {
      main: { x: Math.max(0, left.x - d), y: left.y },
      handle: { x: Math.max(0, left.x - d * 2), y: left.y },
    },
    exit: {
      main: { x: Math.min(CANVAS_W, right.x + d), y: right.y },
      handle: { x: Math.min(CANVAS_W, right.x + d * 2), y: right.y },
    },
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Равномерная прорезка длинного пути с сохранением концов. */
export function resample(path: Point[], max: number): Point[] {
  if (path.length <= max) return path;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) {
    out.push(path[Math.round((i * (path.length - 1)) / (max - 1))]);
  }
  return out;
}

/**
 * Сырой штрих с холста -> готовый глиф в формате HTML.
 * Возвращает null, если штрих слишком короткий.
 */
export function strokeToGlyph(char: string, raw: Point[]): GlyphData | null {
  if (raw.length < MIN_RAW_POINTS) return null;
  const path = resample(smoothPoints(raw), MAX_PATH_POINTS).map((p) => ({ x: round1(p.x), y: round1(p.y) }));
  const anchors = autoDetectAnchors(path);
  if (!anchors) return null;
  const r = (p: Point) => ({ x: round1(p.x), y: round1(p.y) });
  return {
    char,
    metrics: { ...METRICS },
    path,
    anchors: {
      entry: { main: r(anchors.entry.main), handle: r(anchors.entry.handle) },
      exit: { main: r(anchors.exit.main), handle: r(anchors.exit.handle) },
    },
  };
}

/** Физический размер поля в CSS-пикселях по миллиметрам (1 мм = 96/25.4 px). */
export const mmToPx = (mm: number) => (mm * 96) / 25.4;

/** Размер поля в миллиметрах: клетка × число клеток по стороне. */
export const fieldMm = (cellMm: number, fieldCells: number) => cellMm * fieldCells;

// --- Очередь слотов: символ × вариант, автоматически ---

export interface Slot {
  /** Индекс в очереди (0-based). */
  index: number;
  char: string;
  variant: number;
  groupId: string;
  groupTitle: string;
}

export function buildQueue(chars: string[], groupOf: (ch: string) => { id: string; title: string }, variants: number): Slot[] {
  const slots: Slot[] = [];
  for (const ch of chars) {
    const g = groupOf(ch);
    for (let v = 1; v <= variants; v++) {
      slots.push({ index: slots.length, char: ch, variant: v, groupId: g.id, groupTitle: g.title });
    }
  }
  return slots;
}

export const slotId = (char: string, variant: number) => `${char}|${variant}`;

/** Слоты одного экрана (батча) по курсору и размеру экрана. */
export function batchSlots(queue: Slot[], cursor: number, batchSize: number): Slot[] {
  const start = Math.max(0, Math.min(cursor, Math.max(0, queue.length - 1)));
  return queue.slice(start, start + batchSize);
}
