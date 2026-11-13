import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredGlyph } from '../worker/protocol';
import { dbAll } from './db';
import { Harvest } from './Harvest';
import { Library } from './Library';
import { isNative } from './platform';
import { call } from './rpc';
import { Write } from './Write';

type Tab = 'harvest' | 'library' | 'write';

/** Where the recogniser model is looked for: next to the app first, then the public copy on Hugging Face. */
const MODEL_URLS = [
  new URL('./models/ocr_model.onnx', document.baseURI).href,
  'https://huggingface.co/ai-forever/ReadingPipeline-notebooks/resolve/main/ocr/ocr_model.onnx',
];

export type OcrState = { state: 'off' | 'loading' | 'ready' | 'error'; note: string };

export function App() {
  const [tab, setTab] = useState<Tab>('harvest');
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState('');
  const [ocr, setOcr] = useState<OcrState>({ state: 'off', note: '' });
  const [glyphs, setGlyphs] = useState<StoredGlyph[]>([]);
  const synced = useRef<StoredGlyph[] | null>(null);

  const loadOcr = useCallback(async () => {
    setOcr({ state: 'loading', note: 'загрузка модели…' });
    try {
      await call('loadOcr', { urls: MODEL_URLS, ortPath: new URL('./ort/', document.baseURI).href, keep: !isNative() }, (p) => {
        const mb = (p.done / 1e6).toFixed(0);
        setOcr({ state: 'loading', note: p.total ? `загрузка модели: ${mb} из ${(p.total / 1e6).toFixed(0)} МБ` : `загрузка модели: ${mb} МБ` });
      });
      setOcr({ state: 'ready', note: '' });
    } catch (e) {
      setOcr({ state: 'error', note: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await call('init', {});
        const all = await dbAll();
        if (!alive) return;
        setGlyphs(all);
        setReady(true);
        if (all.length) setTab('write');
        void loadOcr();
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [loadOcr]);

  /** The worker keeps its own copy of the library; it is refreshed only when the library changed. */
  const syncLibrary = useCallback(async () => {
    if (synced.current === glyphs) return;
    await call('setLibrary', { glyphs });
    synced.current = glyphs;
  }, [glyphs]);

  if (fatal) return <div className="fatal">Не удалось запустить обработку: {fatal}</div>;
  if (!ready) return <div className="splash">Загрузка…</div>;

  return (
    <div className="app">
      <header>
        <h1>Почерк</h1>
        <span className={`ocr ocr-${ocr.state}`} title={ocr.note}>
          {ocr.state === 'ready' ? 'распознавание готово' : ocr.state === 'loading' ? ocr.note : ocr.state === 'error' ? 'распознавание недоступно' : ''}
          {ocr.state === 'error' && <button className="link" onClick={() => void loadOcr()}>повторить</button>}
        </span>
      </header>
      <nav>
        <button className={tab === 'harvest' ? 'on' : ''} onClick={() => setTab('harvest')}>1. Сбор букв</button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>2. Библиотека <b>{glyphs.length}</b></button>
        <button className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>3. Текст → PDF</button>
      </nav>
      <main>
        {ocr.state === 'error' && tab === 'harvest' && <p className="warn">{ocr.note}</p>}
        <div hidden={tab !== 'harvest'}><Harvest glyphs={glyphs} setGlyphs={setGlyphs} ocrReady={ocr.state === 'ready'} /></div>
        <div hidden={tab !== 'library'}><Library glyphs={glyphs} setGlyphs={setGlyphs} /></div>
        <div hidden={tab !== 'write'}><Write glyphs={glyphs} syncLibrary={syncLibrary} ocrReady={ocr.state === 'ready'} /></div>
      </main>
    </div>
  );
}
