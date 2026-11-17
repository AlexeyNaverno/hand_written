import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { useEffect, useMemo, useRef, useState } from 'react';
import { COVERAGE, fileStem } from '../core/charset';
import { metaToJson, type GlyphMeta, type Joint } from '../core/library';
import type { StoredGlyph } from '../worker/protocol';
import { dbClear, dbDelete, dbPutMany, newId } from './db';
import { saveFile } from './platform';
import { call } from './rpc';

const POS: Record<string, string> = { initial: 'начало слова', medial: 'середина', final: 'конец слова', isolated: 'отдельно' };
const KIND: Record<string, string> = { cut: 'измерено', end: 'конец штриха', virtual: 'условно' };

function GlyphCanvas({ g, scale = 2 }: { g: StoredGlyph; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const bmp = await createImageBitmap(new Blob([g.png as BlobPart], { type: 'image/png' }));
      const cv = ref.current;
      if (!alive || !cv) return;
      const m = g.meta;
      const pad = 8;
      cv.width = m.width * scale + 2 * pad;
      cv.height = m.height * scale + 2 * pad;
      const c = cv.getContext('2d')!;
      c.clearRect(0, 0, cv.width, cv.height);
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(220,0,0,.55)';
      c.beginPath(); c.moveTo(0, pad + m.baseline * scale); c.lineTo(cv.width, pad + m.baseline * scale); c.stroke();
      c.strokeStyle = 'rgba(0,150,0,.45)';
      c.beginPath(); c.moveTo(0, pad + (m.baseline - m.x_height) * scale); c.lineTo(cv.width, pad + (m.baseline - m.x_height) * scale); c.stroke();
      c.drawImage(bmp, pad, pad, m.width * scale, m.height * scale);
      const joint = (j: Joint | null, color: string) => {
        if (!j) return;
        c.strokeStyle = color;
        c.fillStyle = j.kind === 'cut' ? '#000' : j.kind === 'end' ? '#0a0' : '#999';
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(pad + j.p0[0] * scale, pad + j.p0[1] * scale); c.lineTo(pad + j.p1[0] * scale, pad + j.p1[1] * scale); c.stroke();
        c.beginPath(); c.arc(pad + j.p0[0] * scale, pad + j.p0[1] * scale, 3, 0, 6.3); c.fill();
      };
      joint(m.entry, '#06f');
      joint(m.exit, '#f50');
      bmp.close();
    })();
    return () => { alive = false; };
  }, [g, scale]);
  return <canvas ref={ref} />;
}

export function Library({ glyphs, setGlyphs }: { glyphs: StoredGlyph[]; setGlyphs: (g: StoredGlyph[]) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of glyphs) if (g.meta.enabled) m.set(g.meta.char, (m.get(g.meta.char) ?? 0) + 1);
    return m;
  }, [glyphs]);
  const known = useMemo(() => new Set(COVERAGE.flatMap((c) => [...c.chars])), []);
  const extra = useMemo(() => [...new Set(glyphs.map((g) => g.meta.char))].filter((c) => !known.has(c)).sort(), [glyphs, known]);
  const variants = sel ? glyphs.filter((g) => g.meta.char === sel) : [];

  async function update(id: string, patch: Partial<GlyphMeta>) {
    const next = glyphs.map((g) => (g.id === id ? { ...g, meta: { ...g.meta, ...patch } } : g));
    await dbPutMany(next.filter((g) => g.id === id));
    setGlyphs(next);
  }
  async function remove(id: string) {
    await dbDelete([id]);
    setGlyphs(glyphs.filter((g) => g.id !== id));
  }
  async function exportZip() {
    const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
    const used = new Map<string, number>();
    for (const g of glyphs) {
      const n = (used.get(g.meta.char) ?? 0) + 1;
      used.set(g.meta.char, n);
      const stem = fileStem(g.meta.char, n);
      files[`symbols/${stem}.png`] = [g.png, { level: 0 }];
      files[`symbols/${stem}.json`] = [strToU8(metaToJson({ ...g.meta, variant: n })), { level: 6 }];
    }
    setMsg(await saveFile('pocherk-symbols.zip', zipSync(files), 'application/zip'));
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    setMsg('импорт…');
    const entries = new Map<string, { png?: Uint8Array; json?: string }>();
    const put = (path: string, data: Uint8Array) => {
      const base = path.split('/').pop() ?? path;
      const dot = base.lastIndexOf('.');
      if (dot <= 0) return;
      const stem = base.slice(0, dot).normalize('NFC');
      const ext = base.slice(dot + 1).toLowerCase();
      const e = entries.get(stem) ?? {};
      if (ext === 'png') e.png = data;
      else if (ext === 'json') e.json = strFromU8(data);
      else return;
      entries.set(stem, e);
    };
    for (const f of Array.from(list)) {
      const data = new Uint8Array(await f.arrayBuffer());
      if (f.name.toLowerCase().endsWith('.zip')) {
        const un = unzipSync(data);
        for (const [path, d] of Object.entries(un)) if (d.length) put(path, d);
      } else put(f.name, data);
    }
    const counter = new Map<string, number>();
    for (const g of glyphs) counter.set(g.meta.char, Math.max(counter.get(g.meta.char) ?? 0, g.meta.variant));
    const added: StoredGlyph[] = [];
    let skipped = 0;
    for (const [stem, e] of entries) {
      if (!e.png) continue;
      try {
        const r = await call('importPng', { png: e.png, json: e.json ?? null, stem });
        if (!r) { skipped++; continue; }
        const id = newId();
        const variant = (counter.get(r.meta.char) ?? 0) + 1;
        counter.set(r.meta.char, variant);
        added.push({ id, png: r.png, meta: { ...r.meta, id, variant } });
      } catch {
        skipped++;
      }
    }
    await dbPutMany(added);
    setGlyphs([...glyphs, ...added]);
    setMsg(`Импортировано: ${added.length}${skipped ? `, пропущено: ${skipped}` : ''}`);
  }
  async function clearAll() {
    if (!window.confirm('Удалить всю библиотеку букв?')) return;
    await dbClear();
    setGlyphs([]);
    setSel(null);
  }

  const cell = (ch: string) => {
    const n = counts.get(ch) ?? 0;
    return <button key={ch} className={`cell ${n ? (n >= 3 ? 'full' : 'some') : 'none'} ${sel === ch ? 'on' : ''}`} onClick={() => setSel(sel === ch ? null : ch)}>{ch}<i>{n || ''}</i></button>;
  };

  return (
    <section>
      <p className="hint">
        Библиотека — это ваши буквы: цветная картинка с прозрачным фоном и описание (линия строки, высота строчных, точки входа и выхода).
        Для живого почерка нужно по 3–5 вариантов каждой буквы. Серые символы ещё не собраны.
      </p>
      {COVERAGE.map((grp) => (
        <div key={grp.title} className="cov">
          <h3>{grp.title}</h3>
          <div className="cells">{[...grp.chars].map(cell)}</div>
        </div>
      ))}
      {extra.length > 0 && <div className="cov"><h3>Другие</h3><div className="cells">{extra.map(cell)}</div></div>}
      {sel && (
        <div className="card">
          <h3>«{sel}»: вариантов {variants.length}</h3>
          {!variants.length && <p className="meta">Этого символа пока нет. Он появится после сбора с фото, где он написан.</p>}
          <div className="variants">
            {variants.map((g) => (
              <div key={g.id} className={`variant ${g.meta.enabled ? '' : 'off'}`}>
                <GlyphCanvas g={g} />
                <div className="vmeta">
                  <span>{POS[g.meta.position]}{g.meta.prev || g.meta.next ? `: ${g.meta.prev || '·'}_${g.meta.next || '·'}` : ''}</span>
                  {g.meta.entry && <span className="j-in">вход: {KIND[g.meta.entry.kind]}</span>}
                  {g.meta.exit && <span className="j-out">выход: {KIND[g.meta.exit.kind]}</span>}
                </div>
                <div className="row">
                  <button className="btn small" onClick={() => void update(g.id, { enabled: !g.meta.enabled })}>{g.meta.enabled ? 'выключить' : 'включить'}</button>
                  <button className="btn small danger" onClick={() => void remove(g.id)}>удалить</button>
                </div>
              </div>
            ))}
          </div>
          <p className="meta">Красная линия — строка, зелёная — верх строчных. Синий отрезок — вход, оранжевый — выход; чёрная точка означает, что стык измерен на настоящем соединении.</p>
        </div>
      )}
      <div className="row wrap">
        <button className="btn" disabled={!glyphs.length} onClick={() => void exportZip()}>Сохранить библиотеку (ZIP)</button>
        <label className="btn">Загрузить ZIP или файлы PNG+JSON<input type="file" multiple accept=".zip,.png,.json,application/zip,image/png,application/json" hidden onChange={(e) => { void importFiles(e.target.files); e.target.value = ''; }} /></label>
        <button className="btn danger" disabled={!glyphs.length} onClick={() => void clearAll()}>Очистить</button>
      </div>
      {msg && <p className="okmsg">{msg}</p>}
      <p className="meta">В ZIP лежит папка symbols с парами PNG и JSON. Формат совместим со старой программой: поля bbox, baseline, left_joint, right_joint сохранены, её папку symbols тоже можно загрузить сюда.</p>
    </section>
  );
}
