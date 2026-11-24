import { useEffect, useMemo, useRef, useState } from 'react';
import type { GlyphData } from '../core/glyph';
import { ALL_CHARS } from '../core/charset';
import {
  DEFAULT_SHEET,
  PAGE_MM,
  cleanText,
  layoutPages,
  tokenize,
  type PlacedPage,
  type SheetSettings,
} from '../core/sheet';
import { exportPdf, renderPreview } from '../core/render';
import { saveFile } from '../platform';

interface Props {
  glyphs: Record<string, GlyphData>;
  sheet: SheetSettings;
  onChange: (s: SheetSettings) => void;
}

function NumberRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="setting-row">
      <span>
        {props.label} <b>{props.value}{props.suffix ? ` ${props.suffix}` : ''}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

function SelectRow(props: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="setting-row">
      <span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([v, title]) => (
          <option key={v} value={v}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SheetTab({ glyphs, sheet, onChange }: Props) {
  const [pageIndex, setPageIndex] = useState(0);
  const [pages, setPages] = useState<PlacedPage[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [status, setStatus] = useState('Введите текст и нажмите «Разложить по страницам»');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [progress, setProgress] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const set = (patch: Partial<SheetSettings>) => onChange({ ...sheet, ...patch });

  /** Библиотека вариантов по символу. */
  const library = useMemo(() => {
    const map = new Map<string, GlyphData[]>();
    for (const ch of ALL_CHARS) {
      const list: GlyphData[] = [];
      for (let v = 1; v <= 8; v++) {
        const g = glyphs[`${ch}|${v}`];
        if (g) list.push(g);
      }
      if (list.length > 0) map.set(ch, list);
    }
    // знаки, которые могли попасть в данные под другими именами
    for (const [key, g] of Object.entries(glyphs)) {
      const ch = key.split('|')[0];
      if (!map.has(ch)) map.set(ch, [g]);
      else if (!map.get(ch)!.includes(g)) map.get(ch)!.push(g);
    }
    return map;
  }, [glyphs]);

  const available = useMemo(() => new Set(library.keys()), [library]);

  const layout = () => {
    const text = cleanText(sheet.text, available);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      setStatus('Текст пуст после очистки: нужны хотя бы один символ и нарисованные глифы');
      setPages([]);
      return;
    }
    const res = layoutPages(tokens, library, sheet);
    setPages(res.pages);
    setMissing(res.missing);
    // держим текущую страницу, если она ещё существует (правки текста не сбрасывают просмотр)
    setPageIndex((i) => Math.max(0, Math.min(i, res.pages.length - 1)));
    setStatus(
      `Разложено: ${res.pages.length} стр.` +
        (res.missing.length ? ` · нет глифов для: ${res.missing.join(' ')}` : ' · все символы найдены'),
    );
  };

  // отрисовка текущей страницы предпросмотра (с дебаунсом, чтобы ползунки не тормозили)
  useEffect(() => {
    const page = pages[pageIndex];
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    const timer = setTimeout(() => {
      const dpi = Math.min(300, Math.max(120, Math.round(Math.min(sheet.dpiX, sheet.dpiY))));
      const rendered = renderPreview(page, sheet, dpi);
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(rendered, 0, 0);
    }, 200);
    return () => clearTimeout(timer);
  }, [pages, pageIndex, sheet]);

  // автораскладка при открытии вкладки и после правок (с дебаунсом)
  const autoLaid = useRef(false);
  useEffect(() => {
    if (library.size === 0) return;
    const timer = setTimeout(() => {
      autoLaid.current = true;
      layout();
    }, autoLaid.current ? 400 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, sheet]);

  const onExportPdf = async () => {
    if (busy) return;
    const text = cleanText(sheet.text, available);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      setStatus('Нечего экспортировать: текст пуст');
      return;
    }
    setBusy(true);
    setProgress('');
    try {
      const res = layoutPages(tokens, library, sheet);
      if (res.pages.length === 0) {
        setStatus('Не удалось разложить текст — проверьте размеры');
        return;
      }
      if (res.missing.length > 0) setMissing(res.missing);
      const blob = await exportPdf(res.pages, sheet, (p) => setProgress(`Страница ${p.page} из ${p.total}`));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = `pocherk-${sheet.pageFormat}-${sheet.dpiX}x${sheet.dpiY}.pdf`;
      const msg = await saveFile(name, bytes, 'application/pdf');
      setStatus(`${msg} Страниц: ${res.pages.length}.`);
    } catch (err) {
      setStatus(`Ошибка экспорта PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProgress('');
      setBusy(false);
    }
  };

  const page = pages[pageIndex];
  const [pw, ph] = PAGE_MM[sheet.pageFormat];

  return (
    <main className="workspace sheet">
      <div className="sheet-layout">
        <aside className="sheet-side">
          <button className="sheet-toggle" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? '▾ Параметры листа' : '▸ Параметры листа'}
          </button>
          {showSettings && (
            <>
              <div className="sheet-group">
                <strong>Размеры букв</strong>
                <NumberRow label="Строчные" value={sheet.lowerMm} min={1} max={20} step={0.5} suffix="мм" onChange={(v) => set({ lowerMm: v })} />
                <NumberRow label="Заглавные" value={sheet.upperMm} min={1} max={20} step={0.5} suffix="мм" onChange={(v) => set({ upperMm: v })} />
                <NumberRow label="Высота строки" value={sheet.rowHeightMm} min={2} max={30} step={0.5} suffix="мм" onChange={(v) => set({ rowHeightMm: v })} />
                <NumberRow label="Абзацный отступ" value={sheet.indentMm} min={0} max={30} step={1} suffix="мм" onChange={(v) => set({ indentMm: v })} />
                <NumberRow label="Сдвиг между буквами" value={sheet.shiftMm} min={-1} max={1} step={0.05} suffix="мм" onChange={(v) => set({ shiftMm: v })} />
                <NumberRow label="Макс. строк (0 — без лимита)" value={sheet.maxLinesPerPage} min={0} max={60} step={1} onChange={(v) => set({ maxLinesPerPage: Math.round(v) })} />
              </div>

              <div className="sheet-group">
                <strong>Страница и переплёт</strong>
                <SelectRow
                  label="Формат"
                  value={sheet.pageFormat}
                  options={[
                    ['A5', 'A5 — 148×210 мм'],
                    ['A4', 'A4 — 210×297 мм'],
                  ]}
                  onChange={(v) => set({ pageFormat: v as SheetSettings['pageFormat'] })}
                />
                <SelectRow
                  label="Переплёт"
                  value={sheet.bindingSide}
                  options={[
                    ['left', 'Слева'],
                    ['right', 'Справа'],
                  ]}
                  onChange={(v) => set({ bindingSide: v as 'left' | 'right' })}
                />
                <label className="setting-check">
                  <input type="checkbox" checked={sheet.alternateBinding} onChange={(e) => set({ alternateBinding: e.target.checked })} />
                  Чередовать стороны переплёта по страницам
                </label>
                <NumberRow label="Ширина переплёта" value={sheet.bindingWidthMm} min={0} max={30} step={1} suffix="мм" onChange={(v) => set({ bindingWidthMm: v })} />
                <NumberRow label="Поле сверху" value={sheet.marginTopMm} min={0} max={40} step={1} suffix="мм" onChange={(v) => set({ marginTopMm: v })} />
                <NumberRow label="Поле снизу" value={sheet.marginBottomMm} min={0} max={40} step={1} suffix="мм" onChange={(v) => set({ marginBottomMm: v })} />
                <NumberRow label="Поле слева (до переплёта)" value={sheet.marginLeftMm} min={0} max={40} step={1} suffix="мм" onChange={(v) => set({ marginLeftMm: v })} />
                <NumberRow label="Поле справа" value={sheet.marginRightMm} min={0} max={40} step={1} suffix="мм" onChange={(v) => set({ marginRightMm: v })} />
                <label className="setting-check">
                  <input type="checkbox" checked={sheet.printPunct} onChange={(e) => set({ printPunct: e.target.checked })} />
                  Печатать знаки препинания
                </label>
              </div>

              <div className="sheet-group">
                <strong>Ручка и краска</strong>
                <label className="setting-row">
                  <span>Цвет чернил</span>
                  <input type="color" value={sheet.inkColor} onChange={(e) => set({ inkColor: e.target.value })} />
                </label>
                <NumberRow label="Толщина пера" value={sheet.penThicknessMm} min={0.1} max={1.5} step={0.05} suffix="мм" onChange={(v) => set({ penThicknessMm: v })} />
                <NumberRow label="Смягчение края" value={Math.round(sheet.penSoftness * 100)} min={0} max={100} step={5} suffix="%" onChange={(v) => set({ penSoftness: v / 100 })} />
                <NumberRow label="Неравномерность нажима" value={Math.round(sheet.penUnevenness * 100)} min={0} max={100} step={5} suffix="%" onChange={(v) => set({ penUnevenness: v / 100 })} />
              </div>

              <div className="sheet-group">
                <strong>DPI печати (отдельно X и Y)</strong>
                <NumberRow label="По горизонтали (X)" value={sheet.dpiX} min={150} max={2400} step={50} suffix="dpi" onChange={(v) => set({ dpiX: Math.round(v) })} />
                <NumberRow label="По вертикали (Y)" value={sheet.dpiY} min={150} max={2400} step={50} suffix="dpi" onChange={(v) => set({ dpiY: Math.round(v) })} />
                <div className="dpi-presets">
                  <button onClick={() => set({ dpiX: 600, dpiY: 600 })}>600×600</button>
                  <button onClick={() => set({ dpiX: 1200, dpiY: 1200 })}>1200×1200</button>
                  <button onClick={() => set({ dpiX: 1200, dpiY: 2400 })}>1200×2400</button>
                  <button onClick={() => set({ dpiX: 300, dpiY: 300 })}>300×300</button>
                </div>
                <p className="hint">
                  {sheet.pageFormat}: {(Math.round((pw * sheet.dpiX) / 25.4)).toLocaleString('ru-Ru')}×
                  {(Math.round((ph * sheet.dpiY) / 25.4)).toLocaleString('ru-Ru')} точек. Файл режется на тайлы до 4096 px,
                  страницы собираются по очереди.
                </p>
              </div>

              <button className="ghost" onClick={() => onChange({ ...DEFAULT_SHEET, text: sheet.text })}>
                Сбросить параметры листа
              </button>
            </>
          )}
        </aside>

        <section className="sheet-main">
          <label className="sheet-text">
            <span>
              Текст · <b>**заголовок**</b> по центру, <b>*подзаголовок*</b> с отступом, перенос строки — новый абзац
            </span>
            <textarea value={sheet.text} onChange={(e) => set({ text: e.target.value })} spellCheck={false} />
          </label>

          <div className="sheet-actions">
            <button className="primary" onClick={layout}>
              Разложить по страницам
            </button>
            <button className="primary" disabled={busy} onClick={() => void onExportPdf()}>
              {busy ? 'Собираю PDF…' : 'Экспорт PDF'}
            </button>
            {progress && <span className="status">{progress}</span>}
          </div>

          <div className="sheet-preview">
            <div className="sheet-nav">
              <button disabled={pageIndex <= 0} onClick={() => setPageIndex((i) => Math.max(0, i - 1))}>
                ← Предыдущая
              </button>
              <span>
                Страница {pages.length ? pageIndex + 1 : 0} / {pages.length}
                {' · '}
                {pw}×{ph} мм
              </span>
              <button disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}>
                Следующая →
              </button>
            </div>
            {page ? (
              <canvas ref={canvasRef} className="sheet-canvas" />
            ) : (
              <div className="sheet-empty">Предпросмотр появится после раскладки текста</div>
            )}
          </div>

          <p className="status">{status}</p>
          {missing.length > 0 && (
            <p className="hint">
              Нет нарисованных глифов для: <b>{missing.join(' ')}</b> — дорисуйте их на вкладке «Прописи» или исключите из текста.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
