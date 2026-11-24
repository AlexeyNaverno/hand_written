/**
 * Рендер страницы в растр и экспорт PDF.
 * Страница рисуется штампами пера (см. sheet.ts) на canvas в заданном DPI
 * по горизонтали и вертикали; для PDF страница режется на тайлы не больше
 * 2048 px, чтобы высокий DPI (например, 1200x2400) не превышал лимиты canvas.
 * Страницы обрабатываются последовательно, по одной.
 */
import type { PlacedPage, SheetSettings, Stamp } from './sheet';
import { buildStamps } from './sheet';

const MAX_TILE_PX = 2048;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export interface TileRect {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/** Нарисовать штампы (только попадающие в тайл) на canvas размером с тайл. */
const SPRITE_PX = 128;
const SOFT_BUCKETS = 6;

/**
 * Спрайт штампа пера: круг с радиальным профилем плотности.
 * Мягкость края квантуется по бакетам, чтобы не строить градиент на каждый штамп.
 */
const spriteCache = new Map<string, HTMLCanvasElement>();

function stampSprite(color: string, soft: number): HTMLCanvasElement {
  const key = `${color}|${soft.toFixed(2)}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_PX;
  canvas.height = SPRITE_PX;
  const ctx = canvas.getContext('2d')!;
  const c = SPRITE_PX / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  const [r, g, b] = hexToRgb(color);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.72, `rgba(${r},${g},${b},${1 - soft * 0.55})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},${1 - soft})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  spriteCache.set(key, canvas);
  return canvas;
}

/** Нарисовать штампы (только попадающие в тайл) на canvas размером с тайл. */
export function renderStampsToCanvas(
  stamps: Stamp[],
  tile: TileRect,
  dpiX: number,
  dpiY: number,
  inkColor: string,
): HTMLCanvasElement {
  const pxPerMmX = dpiX / 25.4;
  const pxPerMmY = dpiY / 25.4;
  const wPx = Math.max(1, Math.round(tile.wMm * pxPerMmX));
  const hPx = Math.max(1, Math.round(tile.hMm * pxPerMmY));
  const canvas = document.createElement('canvas');
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, wPx, hPx);
  // дальше координаты в миллиметрах: перо, ширина и смягчение не зависят от DPI
  ctx.setTransform(pxPerMmX, 0, 0, pxPerMmY, -tile.xMm * pxPerMmX, -tile.yMm * pxPerMmY);
  ctx.imageSmoothingEnabled = true;

  const x0 = tile.xMm;
  const y0 = tile.yMm;
  const x1 = tile.xMm + tile.wMm;
  const y1 = tile.yMm + tile.hMm;

  for (const st of stamps) {
    if (st.x + st.r < x0 || st.x - st.r > x1 || st.y + st.r < y0 || st.y - st.r > y1) continue;
    const bucket = Math.round(st.soft * (SOFT_BUCKETS - 1)) / (SOFT_BUCKETS - 1);
    const sprite = stampSprite(inkColor, bucket);
    ctx.globalAlpha = st.alpha;
    ctx.drawImage(sprite, st.x - st.r, st.y - st.r, st.r * 2, st.r * 2);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Разбиение страницы на тайлы ≤ MAX_TILE_PX по каждой стороне при заданном DPI. */
export function planTiles(pageW: number, pageH: number, dpiX: number, dpiY: number): TileRect[] {
  const tileMmX = (MAX_TILE_PX / dpiX) * 25.4;
  const tileMmY = (MAX_TILE_PX / dpiY) * 25.4;
  const tilesX = Math.ceil(pageW / tileMmX);
  const tilesY = Math.ceil(pageH / tileMmY);
  const tiles: TileRect[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      tiles.push({
        xMm: tx * tileMmX,
        yMm: ty * tileMmY,
        wMm: Math.min(tileMmX, pageW - tx * tileMmX),
        hMm: Math.min(tileMmY, pageH - ty * tileMmY),
      });
    }
  }
  return tiles;
}

/** Кроп тайла: рендер с запасом по краям убирает швы между тайлами. */
function cropCanvas(src: HTMLCanvasElement, sx: number, sy: number, w: number, h: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w));
  out.height = Math.max(1, Math.round(h));
  out.getContext('2d')!.drawImage(src, Math.round(sx), Math.round(sy), out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Не удалось создать изображение страницы'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

export interface PdfProgress {
  page: number;
  total: number;
}

/** Собрать PDF из страниц. Страницы и тайлы обрабатываются последовательно. */
export async function exportPdf(
  pages: PlacedPage[],
  s: SheetSettings,
  onProgress?: (p: PdfProgress) => void,
): Promise<Blob> {
  // jsPDF грузится лениво: предпросмотр не тянет библиотеку PDF
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: [pages[0]?.widthMm ?? 148, pages[0]?.heightMm ?? 210], orientation: 'portrait', compress: true });
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    if (pi > 0) doc.addPage([page.widthMm, page.heightMm], 'portrait');
    const stamps = buildStamps(page, s);
    for (const tile of planTiles(page.widthMm, page.heightMm, s.dpiX, s.dpiY)) {
      // запас 1 мм по краям: штампы на границе тайла не обрезаются и не дают шва
      const pad = 1;
      const padded: TileRect = {
        xMm: tile.xMm - pad,
        yMm: tile.yMm - pad,
        wMm: tile.wMm + pad * 2,
        hMm: tile.hMm + pad * 2,
      };
      const rendered = renderStampsToCanvas(stamps, padded, s.dpiX, s.dpiY, s.inkColor);
      const canvas = cropCanvas(
        rendered,
        (pad * s.dpiX) / 25.4,
        (pad * s.dpiY) / 25.4,
        (tile.wMm * s.dpiX) / 25.4,
        (tile.hMm * s.dpiY) / 25.4,
      );
      const dataUrl = await canvasToDataUrl(canvas);
      doc.addImage(dataUrl, 'PNG', tile.xMm, tile.yMm, tile.wMm, tile.hMm);
      // отдаём поток браузеру, чтобы не блокировать интерфейс на высоком DPI
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    onProgress?.({ page: pi + 1, total: pages.length });
  }
  return doc.output('blob') as Blob;
}

/** Предпросмотр одной страницы в заданном DPI (обычно 150). */
export function renderPreview(page: PlacedPage, s: SheetSettings, dpi = 150): HTMLCanvasElement {
  const stamps = buildStamps(page, s);
  return renderStampsToCanvas(stamps, { xMm: 0, yMm: 0, wMm: page.widthMm, hMm: page.heightMm }, dpi, dpi, s.inkColor);
}
