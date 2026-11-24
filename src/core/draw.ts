/**
 * Отрисовка холста: белый фон, сетка клеток, штрих и 4 точки входа/выхода.
 *
 * Холст в данных всегда 600x600, а на экране он может быть 57 px (15 мм) или больше.
 * Поэтому толщины линий задаются в ЭКРАННЫХ пикселях и переводятся в логические
 * через коэффициент s = 600 / displayPx — иначе сетка при маленьком экране
 * становится невидимой (1 логическая единица = 0,1 px).
 *
 * Два режима:
 *  - 'cells' — клетки на главном экране: только сетка, буква и 4 точки, без лишних линий;
 *  - 'full'  — редактор анкеров: сетка, верхняя и базовая линии, боковые поля
 *              и линии от точек к их управляющим точкам.
 */
import { CANVAS_H, CANVAS_W, METRICS, type Anchors, type Point } from './glyph';

export type GuideMode = 'cells' | 'full';

export function drawGuides(ctx: CanvasRenderingContext2D, fieldCells: number, s: number, mode: GuideMode = 'cells'): void {
  const cellW = CANVAS_W / fieldCells;
  const cellH = CANVAS_H / fieldCells;

  // --- сетка клеток: сплошные тонкие линии ---
  ctx.setLineDash([]);
  ctx.strokeStyle = '#c3d0e6';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  for (let i = 1; i < fieldCells; i++) {
    const x = cellW * i;
    const y = cellH * i;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_H);
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
  }
  ctx.stroke();

  // внешний контур поля
  ctx.strokeStyle = '#a9bad4';
  ctx.lineWidth = 1.5 * s;
  ctx.strokeRect(0.75 * s, 0.75 * s, CANVAS_W - 1.5 * s, CANVAS_H - 1.5 * s);

  if (mode === 'cells') return;

  // --- редактор: показываем уровни и поля ---
  // боковые поля (10% и 90% ширины)
  ctx.setLineDash([4 * s, 5 * s]);
  ctx.strokeStyle = '#d7d7d7';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(CANVAS_W * 0.1, 0);
  ctx.lineTo(CANVAS_W * 0.1, CANVAS_H);
  ctx.moveTo(CANVAS_W * 0.9, 0);
  ctx.lineTo(CANVAS_W * 0.9, CANVAS_H);
  ctx.stroke();
  ctx.setLineDash([]);

  // верхняя линия — верх центральной клетки
  ctx.strokeStyle = '#5b8dd6';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(0, METRICS.topLineY);
  ctx.lineTo(CANVAS_W, METRICS.topLineY);
  ctx.stroke();

  // базовая линия — низ центральной клетки
  ctx.strokeStyle = '#e74c3c';
  ctx.beginPath();
  ctx.moveTo(0, METRICS.baselineY);
  ctx.lineTo(CANVAS_W, METRICS.baselineY);
  ctx.stroke();
}

export function drawStroke(ctx: CanvasRenderingContext2D, path: Point[], widthLogical: number): void {
  if (path.length < 2) return;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = widthLogical;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  ctx.stroke();
}

export type AnchorKey = 'entryMain' | 'entryHandle' | 'exitMain' | 'exitHandle';

export function getAnchor(anchors: Anchors, key: AnchorKey): Point {
  switch (key) {
    case 'entryMain':
      return anchors.entry.main;
    case 'entryHandle':
      return anchors.entry.handle;
    case 'exitMain':
      return anchors.exit.main;
    case 'exitHandle':
      return anchors.exit.handle;
  }
}

export function setAnchor(anchors: Anchors, key: AnchorKey, p: Point): Anchors {
  const copy: Anchors = {
    entry: { main: { ...anchors.entry.main }, handle: { ...anchors.entry.handle } },
    exit: { main: { ...anchors.exit.main }, handle: { ...anchors.exit.handle } },
  };
  switch (key) {
    case 'entryMain':
      copy.entry.main = p;
      break;
    case 'entryHandle':
      copy.entry.handle = p;
      break;
    case 'exitMain':
      copy.exit.main = p;
      break;
    case 'exitHandle':
      copy.exit.handle = p;
      break;
  }
  return copy;
}

/**
 * Четыре точки: вход (main + handle) и выход (main + handle).
 * В клетках главного экрана — только точки; в редакторе ещё и линии к handle.
 */
export function drawAnchors(
  ctx: CanvasRenderingContext2D,
  anchors: Anchors,
  selected: AnchorKey | null,
  s: number,
  showLinks = false,
): void {
  if (showLinks) {
    ctx.setLineDash([]);
    ctx.lineWidth = 1 * s;
    ctx.globalAlpha = 0.55;
    for (const type of ['entry', 'exit'] as const) {
      ctx.strokeStyle = type === 'entry' ? '#2ecc71' : '#e74c3c';
      ctx.beginPath();
      ctx.moveTo(anchors[type].main.x, anchors[type].main.y);
      ctx.lineTo(anchors[type].handle.x, anchors[type].handle.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const dot = (p: Point, color: string, isSelected: boolean, r: number, hollow: boolean) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, (isSelected ? r + 2 : r) * s, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? '#4a9eff' : hollow ? '#ffffff' : color;
    ctx.fill();
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = isSelected ? '#ffffff' : color;
    ctx.stroke();
  };

  dot(anchors.entry.handle, '#2ecc71', selected === 'entryHandle', 4, true);
  dot(anchors.entry.main, '#2ecc71', selected === 'entryMain', 6, false);
  dot(anchors.exit.handle, '#e74c3c', selected === 'exitHandle', 4, true);
  dot(anchors.exit.main, '#e74c3c', selected === 'exitMain', 6, false);
}

export function drawCanvas(
  ctx: CanvasRenderingContext2D,
  opts: {
    fieldCells: number;
    showGuides: boolean;
    /** Толщина штриха в экранных пикселях. */
    strokeWidth: number;
    /** CSS-размер холста на экране. */
    displayPx: number;
    path: Point[];
    anchors: Anchors | null;
    selectedAnchor: AnchorKey | null;
    /** 'cells' — компактные клетки, 'full' — полный набор линий для редактора. */
    mode?: GuideMode;
  },
): void {
  const s = CANVAS_W / opts.displayPx; // логических единиц на 1 экранный пиксель
  const mode = opts.mode ?? 'cells';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (opts.showGuides) drawGuides(ctx, opts.fieldCells, s, mode);
  drawStroke(ctx, opts.path, opts.strokeWidth * s);
  if (opts.anchors) drawAnchors(ctx, opts.anchors, opts.selectedAnchor, s, mode === 'full');
}
