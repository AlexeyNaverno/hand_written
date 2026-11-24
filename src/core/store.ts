/**
 * Хранилище: все нарисованные глифы, курсор очереди и настройки.
 * Пишется в IndexedDB (localStorage на сотни глифов не хватит),
 * сохранение происходит после каждого штриха, очистки и нажатия «Следующий».
 */
import { autoDetectAnchors, METRICS, type GlyphData } from './glyph';
import { DEFAULT_SHEET, type SheetSettings } from './sheet';

export interface Settings {
  /** Размер клетки в миллиметрах (реальный масштаб), минимум 5. */
  cellMm: number;
  /** Сколько клеток по стороне поля — всегда 3 (поле 3×3). */
  fieldCells: number;
  /** Сколько клеток на экране по горизонтали. */
  cols: number;
  /** Сколько клеток на экране по вертикали. */
  rows: number;
  /** Толщина штриха в экранных пикселях. */
  strokeWidth: number;
  /** Показывать сетку клеток. */
  showGuides: boolean;
  /** Сколько вариантов каждого символа требуется (от 1 до 8). */
  variants: number;
}

export const DEFAULT_SETTINGS: Settings = {
  cellMm: 5,
  fieldCells: 3,
  cols: 4,
  rows: 3,
  strokeWidth: 2.5,
  showGuides: true,
  variants: 4,
};

export interface AppState {
  glyphs: Record<string, GlyphData>;
  /** Индекс первого слота текущего экрана в очереди. */
  cursor: number;
  settings: Settings;
  /** Настройки вкладки «Лист» (генерация рукописного текста). */
  sheet: SheetSettings;
}

export const emptyState = (): AppState => ({
  glyphs: {},
  cursor: 0,
  settings: { ...DEFAULT_SETTINGS },
  sheet: { ...DEFAULT_SHEET },
});

const DB_NAME = 'pocherk-glyphs';
const STORE = 'kv';
const KEY = 'state-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Глифы, нарисованные до перехода на уровни «верх/низ центральной клетки»:
 * сдвигаем их на разницу базовых линий и перевыставляем авто-точки, если
 * пользователь их не двигал руками.
 */
function migrateGlyph(g: GlyphData): GlyphData {
  const oldBaseline = g.metrics?.baselineY ?? METRICS.baselineY;
  const dy = METRICS.baselineY - oldBaseline;
  let next = g;
  if (dy !== 0) {
    next = {
      ...g,
      metrics: { ...METRICS },
      path: g.path.map((p) => ({ x: p.x, y: round1(p.y + dy) })),
      anchors: {
        entry: {
          main: { x: g.anchors.entry.main.x, y: round1(g.anchors.entry.main.y + dy) },
          handle: { x: g.anchors.entry.handle.x, y: round1(g.anchors.entry.handle.y + dy) },
        },
        exit: {
          main: { x: g.anchors.exit.main.x, y: round1(g.anchors.exit.main.y + dy) },
          handle: { x: g.anchors.exit.handle.x, y: round1(g.anchors.exit.handle.y + dy) },
        },
      },
    };
  }
  // старые авто-точки стояли ровно в концах штриха — заменяем на новые
  const path = next.path;
  if (path.length >= 4) {
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6;
    const legacy = near(next.anchors.entry.main, path[0]) && near(next.anchors.exit.main, path[path.length - 1]);
    if (legacy) {
      const detected = autoDetectAnchors(path);
      if (detected) next = { ...next, anchors: detected };
    }
  }
  return next;
}

export async function loadState(): Promise<AppState> {
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if (value && typeof value === 'object') {
      const s = value as Partial<AppState>;
      const glyphs: Record<string, GlyphData> = {};
      for (const [key, glyph] of Object.entries(s.glyphs ?? {})) glyphs[key] = migrateGlyph(glyph);
      return {
        glyphs,
        cursor: typeof s.cursor === 'number' ? s.cursor : 0,
        settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) },
        sheet: { ...DEFAULT_SHEET, ...(s.sheet ?? {}) },
      };
    }
  } catch {
    // IndexedDB недоступен — начинаем с чистого состояния
  }
  return emptyState();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: AppState | null = null;

function writeNow(state: AppState): Promise<void> {
  return openDb()
    .then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(state, KEY);
          tx.onsuccess = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        }),
    )
    .catch(() => undefined);
}

/** Сохранение с дебаунсом 250 мс: частые штрихи не дёргают диск на каждый pointermove. */
export function saveState(state: AppState): void {
  pending = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pending) void writeNow(pending);
    pending = null;
  }, 250);
}

/** Немедленное сохранение (нажатие «Следующий», закрытие редактора анкеров). */
export function saveStateNow(state: AppState): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pending = null;
  return writeNow(state);
}

export async function clearAllData(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY);
      tx.onsuccess = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // ignore
  }
}
