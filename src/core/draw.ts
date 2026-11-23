/**
 * Отрисовка холста: белый фон, направляющие, штрих и анкеры — как в HTML-редакторе.
 *
 * Холст в данных всегда 600x600, а на экране он может быть 57 px (15 мм) или больше.
 * Поэтому толщины линий задаются в ЭКРАННЫХ пикселях и переводятся в логические
 * через коэффициент s = 600 / displayPx — иначе направляющие при маленьком
 * экране становятся невидимыми (1 логическая единица = 0,1 px).
 */
import { CANVAS_H, CANVAS_W, METRICS, type Anchors, type Point } from './glyph';

export function drawGuides(ctx: CanvasRenderingContext2D, fieldCells: number, s: number): void {
  ctx.lineWidth = s; // 1 экранный пиксель
  ctx.setLineDash([6 * s, 6 * s]);

  // сетка поля (клетка × fieldCells) — всегда 3×3
  ctx.strokeStyle = '#cce0ff';
  ctx.beginPath();
  for (let i = 1; i < fieldCells; i++) {
    const x = (CANVAS_W / fieldCells) * i;
    const y = (CANVAS_H / fieldCells) * i;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_H);
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
  }
  ctx.stroke();

  // верхняя линия
  ctx.strokeStyle = '#cce0ff';
  ctx.beginPath();
  ctx.moveTo(0, METRICS.topLineY);
  ctx.lineTo(CANVAS_W, METRICS.topLineY);
  ctx.stroke();

  // базовая (нижняя) линия
  ctx.strokeStyle = '#ffb3b3';
  ctx.beginPath();
  ctx.moveTo(0, METRICS.baselineY);
  ctx.lineTo(CANVAS_W, METRICS.baselineY);
  ctx.stroke();

  // боковые поля
  ctx.strokeStyle = '#e0e0e0';
  ctx.beginPath();
  ctx.moveTo(CANVAS_W * 0.1, 0);
  ctx.lineTo(CANVAS_W * 0.1, CANVAS_H);
  ctx.moveTo(CANVAS_W * 0.9, 0);
  ctx.lineTo(CANVAS_W * 0.9, CANVAS_H);
  ctx.stroke();

  ctx.setLineDash([]);
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

export function drawAnchors(ctx: CanvasRenderingContext2D, anchors: Anchors, selected: AnchorKey | null, s: number): void {
  const pair = (type: 'entry' | 'exit', color: string) => {
    const main = anchors[type].main;
    const handle = anchors[type].handle;
    const isSelMain = selected === `${type}Main`;
    const isSelHandle = selected === `${type}Handle`;

    ctx.strokeStyle = color;
    ctx.lineWidth = s;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(main.x, main.y);
    ctx.lineTo(handle.x, handle.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = isSelMain ? '#4a9eff' : color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.arc(main.x, main.y, (isSelMain ? 8 : 6) * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isSelHandle ? '#4a9eff' : '#f39c12';
    const hs = (isSelHandle ? 6 : 4) * s;
    ctx.fillRect(handle.x - hs, handle.y - hs, hs * 2, hs * 2);
  };
  pair('entry', '#2ecc71');
  pair('exit', '#e74c3c');
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
  },
): void {
  const s = CANVAS_W / opts.displayPx; // логических единиц на 1 экранный пиксель
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (opts.showGuides) drawGuides(ctx, opts.fieldCells, s);
  drawStroke(ctx, opts.path, opts.strokeWidth * s);
  if (opts.anchors) drawAnchors(ctx, opts.anchors, opts.selectedAnchor, s);
}
