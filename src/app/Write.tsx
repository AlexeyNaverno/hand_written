import { useEffect, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, type SynthOptions } from '../core/synth/options';
import type { CheckItem, Paper, StoredGlyph } from '../worker/protocol';
import { saveFile } from './platform';
import { call } from './rpc';

const KEY = 'pocherk-write-v1';
interface Saved { text: string; options: SynthOptions; paper: Paper; ink: string }
const SAMPLE = 'Заголовок\nЗдесь будет ваш текст. Абзац из одной короткой строки без точки в конце станет заголовком.';

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (s) return { ...s, options: { ...DEFAULT_OPTIONS, ...s.options } };
  } catch { /* first run */ }
  return { text: SAMPLE, options: DEFAULT_OPTIONS, paper: 'blank', ink: 'source' };
}
const INKS: Record<string, [number, number, number] | null> = { source: null, blue: [28, 46, 140], violet: [58, 40, 130], black: [24, 24, 28] };

export function Write({ glyphs, syncLibrary, ocrReady }: { glyphs: StoredGlyph[]; syncLibrary: () => Promise<void>; ocrReady: boolean }) {
  const init = useRef(load()).current;
  const [text, setText] = useState(init.text);
  const [o, setO] = useState<SynthOptions>(init.options);
  const [paper, setPaper] = useState<Paper>(init.paper);
  const [ink, setInk] = useState(init.ink);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [check, setCheck] = useState<CheckItem[] | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify({ text, options: o, paper, ink } satisfies Saved));
  }, [text, o, paper, ink]);

  const options = (): SynthOptions => ({ ...o, inkColor: INKS[ink] ?? null });
  const set = <K extends keyof SynthOptions>(k: K, v: SynthOptions[K]) => setO((prev) => ({ ...prev, [k]: v }));
  const num = (k: keyof SynthOptions, label: string, step: number, min: number, max: number) => (
    <label className="field small">{label}
      <input type="number" inputMode="decimal" step={step} min={min} max={max} value={o[k] as number}
        onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) set(k, Math.min(max, Math.max(min, v)) as never); }} />
    </label>
  );
  const slider = (k: 'pressureVar' | 'bump' | 'jitter', label: string) => (
    <label className="field small">{label}: {Math.round(o[k] * 100)}%
      <input type="range" min={0} max={1} step={0.05} value={o[k]} onChange={(e) => set(k, parseFloat(e.target.value))} />
    </label>
  );

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    setError(''); setMsg('');
    setBusy(what);
    try {
      await syncLibrary();
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy('');
    }
  }

  async function preview(p = page) {
    setCheck(null);
    const r = await run('отрисовка…', () => call('preview', { text, options: options(), page: p, dpi: 150, paper }));
    if (!r) return;
    setPages(r.pages);
    setMissing(r.missing);
    const cv = canvas.current!;
    cv.width = r.width;
    cv.height = r.height;
    cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer as ArrayBuffer), r.width, r.height), 0, 0);
    setPage(Math.min(p, r.pages - 1));
  }
  async function pdf() {
    const r = await run('PDF…', () => call('pdf', { text, options: options(), paper }, (p) => setBusy(`PDF: строка ${p.done} из ${p.total}`)));
    if (!r) return;
    setMissing(r.missing);
    setMsg(`${await saveFile('pocherk.pdf', r.bytes, 'application/pdf')} (страниц: ${r.pages}, ${(r.bytes.length / 1e6).toFixed(1)} МБ)`);
  }
  async function verify() {
    const r = await run('проверка…', () => call('check', { text, options: options(), page }, (p) => setBusy(`проверка: слово ${p.done} из ${p.total}`)));
    if (r) setCheck(r.items);
  }

  const bad = check?.filter((c) => !c.ok) ?? [];
  return (
    <section>
      {!glyphs.length && <p className="warn">Библиотека пуста: сначала соберите буквы на первой вкладке или загрузите готовую библиотеку на второй.</p>}
      <label className="field">Текст
        <textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </label>
      <p className="meta">Абзац — это строка текста до перевода строки. Абзац короче {o.headingMaxWords} слов, который умещается в одну строку, пишется как заголовок по центру. Нажим пера меняется только между абзацами.</p>
      <details className="card">
        <summary>Лист и почерк</summary>
        <div className="grid">
          <label className="field small">Формат
            <select value={`${o.pageWmm}x${o.pageHmm}`} onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); setO((p) => ({ ...p, pageWmm: w, pageHmm: h })); }}>
              <option value="148x210">A5</option><option value="210x297">A4</option><option value="165x205">Тетрадь 165×205</option>
            </select>
          </label>
          <label className="field small">Фон
            <select value={paper} onChange={(e) => setPaper(e.target.value as Paper)}>
              <option value="blank">чистый</option><option value="squared">клетка 5 мм</option><option value="ruled">линейка</option>
            </select>
          </label>
          <label className="field small">Чернила
            <select value={ink} onChange={(e) => setInk(e.target.value)}>
              <option value="source">как на фото</option><option value="blue">синие</option><option value="violet">фиолетовые</option><option value="black">чёрные</option>
            </select>
          </label>
          {num('xHeightMm', 'Высота строчных, мм', 0.1, 1.2, 6)}
          {num('rowMm', 'Шаг строк, мм', 0.5, 3, 20)}
          {num('wordSpace', 'Пробел, в высотах буквы', 0.1, 0.4, 3)}
          {num('indentMm', 'Красная строка, мм', 1, 0, 40)}
          {num('marginLeftMm', 'Поле слева, мм', 1, 0, 60)}
          {num('marginRightMm', 'Поле справа, мм', 1, 0, 60)}
          {num('marginTopMm', 'Поле сверху, мм', 1, 0, 60)}
          {num('marginBottomMm', 'Поле снизу, мм', 1, 0, 60)}
          {num('bindingMm', 'Отступ под переплёт, мм', 1, 0, 40)}
          {num('dpi', 'Качество PDF, dpi', 50, 150, 600)}
          {slider('pressureVar', 'Разница нажима между абзацами')}
          {slider('bump', 'Бугорок на соединениях')}
          {slider('jitter', 'Неровность почерка')}
          <label className="field small">Вариант раскладки
            <span className="row"><input type="number" value={o.seed} onChange={(e) => set('seed', parseInt(e.target.value, 10) || 1)} />
              <button className="btn small" onClick={() => set('seed', 1 + Math.floor(Math.random() * 99999))}>другой</button></span>
          </label>
          <label className="check"><input type="checkbox" checked={o.headingNoTrailingDot} onChange={(e) => set('headingNoTrailingDot', e.target.checked)} />абзац с точкой или запятой в конце не считать заголовком</label>
        </div>
      </details>
      <div className="row wrap">
        <button className="btn primary" disabled={!!busy || !glyphs.length} onClick={() => void preview(page)}>Предпросмотр</button>
        <button className="btn" disabled={!!busy || !glyphs.length} onClick={() => void pdf()}>Сохранить PDF</button>
        <button className="btn" disabled={!!busy || !glyphs.length || !ocrReady || !pages} onClick={() => void verify()} title="Программа читает написанные слова и сравнивает с текстом">Проверить чтением</button>
        {busy && <span className="busy">{busy}</span>}
      </div>
      {error && <p className="warn">{error}</p>}
      {msg && <p className="okmsg">{msg}</p>}
      {missing.length > 0 && <p className="warn">В библиотеке нет символов: {missing.join(' ')}. На их месте оставлен пробел.</p>}
      {check && (
        <p className={bad.length ? 'warn' : 'okmsg'}>
          {bad.length ? `Не совпало слов: ${bad.length} из ${check.length}. ` : `Все слова (${check.length}) прочитаны верно.`}
          {bad.slice(0, 12).map((c, i) => <span key={i} className="mis">«{c.word}» → «{c.read}»</span>)}
          {bad.length > 0 && ' Попробуйте другой вариант раскладки или выключите неудачные буквы в библиотеке.'}
        </p>
      )}
      {pages > 1 && (
        <div className="row">
          <button className="btn small" disabled={page <= 0 || !!busy} onClick={() => void preview(page - 1)}>←</button>
          <span>страница {page + 1} из {pages}</span>
          <button className="btn small" disabled={page >= pages - 1 || !!busy} onClick={() => void preview(page + 1)}>→</button>
        </div>
      )}
      <div className="page" hidden={!pages}><canvas ref={canvas} /></div>
    </section>
  );
}
