import { useEffect, useMemo, useRef, useState } from 'react';
import type { GlyphMeta } from '../core/library';
import type { AnalyzeResult, LineInfo, StoredGlyph } from '../worker/protocol';
import { dbPutMany, newId } from './db';
import { decodeImageFile } from './platform';
import { call } from './rpc';

interface Cut {
  meta: GlyphMeta;
  png: Uint8Array;
  url: string;
  selected: boolean;
}

interface LineState {
  info: LineInfo;
  text: string;
  busy: string;
  cuts: Cut[] | null;
  added: number;
}

function LinePreview({ info }: { info: LineInfo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = info.width;
    cv.height = info.height;
    const c = cv.getContext('2d')!;
    c.putImageData(new ImageData(new Uint8ClampedArray(info.preview.buffer.slice(0) as ArrayBuffer), info.width, info.height), 0, 0);
    c.strokeStyle = 'rgba(220,0,0,.6)';
    c.beginPath(); c.moveTo(0, info.baseY + 0.5); c.lineTo(info.width, info.baseY + 0.5); c.stroke();
    c.strokeStyle = 'rgba(0,150,0,.5)';
    c.beginPath(); c.moveTo(0, info.baseY - info.xh + 0.5); c.lineTo(info.width, info.baseY - info.xh + 0.5); c.stroke();
  }, [info]);
  return <div className="strip"><canvas ref={ref} /></div>;
}

/** Mean widths of letters already in the library, in x-heights: they sharpen the alignment for this writer. */
function widthStats(glyphs: StoredGlyph[]): [string, number][] {
  const acc = new Map<string, number[]>();
  for (const g of glyphs) {
    const w = (g.meta.bbox[2] - g.meta.bbox[0]) / g.meta.x_height;
    acc.set(g.meta.char, [...(acc.get(g.meta.char) ?? []), w]);
  }
  return [...acc.entries()].filter(([, v]) => v.length >= 2).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]);
}

export function Harvest({ glyphs, setGlyphs, ocrReady }: { glyphs: StoredGlyph[]; setGlyphs: (g: StoredGlyph[]) => void; ocrReady: boolean }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<AnalyzeResult | null>(null);
  const [lines, setLines] = useState<LineState[]>([]);
  const widths = useMemo(() => widthStats(glyphs), [glyphs]);
  const glyphsRef = useRef(glyphs);
  glyphsRef.current = glyphs;

  const patch = (i: number, p: Partial<LineState>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setLines([]);
    setSummary(null);
    try {
      setBusy('чтение фото…');
      const img = await decodeImageFile(file);
      setBusy('поиск строк…');
      const res = await call('analyze', { ...img, name: file.name }, (p) => setBusy(`${p.note ?? 'обработка'}: ${p.done} из ${p.total}`), [img.rgba.buffer]);
      setSummary(res);
      setLines(res.lines.map((info) => ({ info, text: info.text, busy: '', cuts: null, added: 0 })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function extract(i: number, text: string) {
    patch(i, { busy: 'разбор…', cuts: null, added: 0 });
    try {
      const res = await call('extract', { line: i, text, widths }, (p) => patch(i, { busy: `${p.note ?? 'разбор'}: ${p.done} из ${p.total}` }));
      const cuts = res.glyphs.map((g) => ({ ...g, url: URL.createObjectURL(new Blob([g.png as BlobPart], { type: 'image/png' })), selected: g.meta.quality.auto }));
      patch(i, { busy: '', cuts });
    } catch (e) {
      patch(i, { busy: '' });
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function extractAll() {
    for (let i = 0; i < lines.length; i++) if (!lines[i].cuts && lines[i].text.trim()) await extract(i, lines[i].text);
  }

  async function add(i: number) {
    const ln = lines[i];
    if (!ln.cuts) return;
    const chosen = ln.cuts.filter((c) => c.selected);
    if (!chosen.length) return;
    const counts = new Map<string, number>();
    for (const g of glyphsRef.current) counts.set(g.meta.char, Math.max(counts.get(g.meta.char) ?? 0, g.meta.variant));
    const items: StoredGlyph[] = chosen.map((c) => {
      const id = newId();
      const variant = (counts.get(c.meta.char) ?? 0) + 1;
      counts.set(c.meta.char, variant);
      return { id, png: c.png, meta: { ...c.meta, id, variant, checked_by_user: true } };
    });
    await dbPutMany(items);
    setGlyphs([...glyphsRef.current, ...items]);
    patch(i, { added: items.length, cuts: ln.cuts.map((c) => (c.selected ? { ...c, selected: false } : c)) });
  }

  const toggle = (i: number, k: number) => patch(i, { cuts: lines[i].cuts!.map((c, j) => (j === k ? { ...c, selected: !c.selected } : c)) });
  const relabel = (i: number, k: number) => {
    const cur = lines[i].cuts![k];
    const ch = window.prompt('Какой это символ?', cur.meta.char);
    if (!ch || [...ch.trim()].length !== 1) return;
    patch(i, { cuts: lines[i].cuts!.map((c, j) => (j === k ? { ...c, selected: true, meta: { ...c.meta, char: ch.trim() } } : c)) });
  };

  return (
    <section>
      <p className="hint">
        Сфотографируйте страницу обычного рукописного текста: одна страница на кадр, ровный свет, без сжатия в мессенджере.
        Программа найдёт строки, прочитает их и вырежет буквы. Чем больше страниц, тем больше вариантов каждой буквы.
      </p>
      <div className="row">
        <label className="btn primary">Снять на камеру<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <label className="btn">Выбрать фото<input type="file" accept="image/*" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="warn">{error}</p>}
      {summary && (
        <p className="meta">
          Строк: {summary.lines.length}. Линовка: {summary.ruling}. Наклон листа: {summary.skewDeg.toFixed(1)}°. Высота строчных: {summary.xHeight.toFixed(0)} px, штрих: {summary.strokeWidth.toFixed(1)} px.
          {summary.strokeWidth < 3 && ' Штрих тоньше 3 px: снимок мелкий, буквы получатся размытыми, лучше снять крупнее.'}
          {!ocrReady && ' Распознавание не загружено: введите текст строк вручную.'}
        </p>
      )}
      {lines.length > 1 && <div className="row"><button className="btn" onClick={() => void extractAll()}>Разобрать все строки</button></div>}
      {lines.map((ln, i) => (
        <div className="card" key={i}>
          <LinePreview info={ln.info} />
          <label className="field">Текст строки (исправьте ошибки чтения)
            <input value={ln.text} onChange={(e) => patch(i, { text: e.target.value })} placeholder="что написано в этой строке" />
          </label>
          <div className="row">
            <button className="btn" disabled={!!ln.busy || !ln.text.trim()} onClick={() => void extract(i, ln.text)}>Разобрать на буквы</button>
            {ln.busy && <span className="busy">{ln.busy}</span>}
          </div>
          {ln.cuts && (
            <>
              <div className="tiles">
                {ln.cuts.map((c, k) => (
                  <div key={k} className={`tile ${c.selected ? 'sel' : ''} ${c.meta.quality.auto ? 'ok' : 'doubt'}`} onClick={() => toggle(i, k)}
                    title={c.meta.quality.read !== undefined ? `прочитано отдельно: «${c.meta.quality.read}»` : ''}>
                    <img src={c.url} alt={c.meta.char} />
                    <button className="chr" onClick={(e) => { e.stopPropagation(); relabel(i, k); }}>{c.meta.char}</button>
                  </div>
                ))}
              </div>
              <p className="meta">
                Зелёная рамка: буква прочитана отдельно так же, как в тексте, и выбрана. Серая: сомнительная, не выбрана. Нажатие меняет выбор, нажатие на подпись исправляет символ.
              </p>
              <div className="row">
                <button className="btn primary" disabled={!ln.cuts.some((c) => c.selected)} onClick={() => void add(i)}>
                  В библиотеку: {ln.cuts.filter((c) => c.selected).length}
                </button>
                {ln.added > 0 && <span className="okmsg">добавлено {ln.added}</span>}
              </div>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
