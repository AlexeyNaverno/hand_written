import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { entryLevel, exitLevel, isJoining } from '../core/charset';
import { encodePng } from '../core/png';
import { trimInkCell, whitePaper } from '../core/worksheet';
import type { GlyphMeta, Joint } from '../core/library';
import type { StoredGlyph } from '../worker/protocol';
import { dbPutMany, newId } from './db';
import { decodeImageFile, saveFile } from './platform';
import { call } from './rpc';

(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type Bounds = { x0: number; y0: number; x1: number; y1: number };
type Side = 'entry' | 'exit';
type Pair = { p0: [number, number] | null; p1: [number, number] | null };
interface PreparedCell {
  row: number;
  col: number;
  rgba: Uint8Array;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  char: string;
  confidence: number;
  inset: number;
  saved?: boolean;
}

const INITIAL_BOUNDS: Bounds = { x0: .025, y0: .025, x1: .975, y1: .975 };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Cut one cell, remove paper colour, trim to the ink, and normalise lowercase ink height to 64 px. */
function prepareCell(source: HTMLCanvasElement, rows: number, cols: number, bounds: Bounds, row: number, col: number, inset: number): Omit<PreparedCell, 'char' | 'confidence'> | null {
  const W = source.width, H = source.height;
  const cellW = (bounds.x1 - bounds.x0) * W / cols;
  const cellH = (bounds.y1 - bounds.y0) * H / rows;
  const pad = clamp(inset, 0, 35) / 100;
  const x0 = Math.round((bounds.x0 + (bounds.x1 - bounds.x0) * col / cols) * W + cellW * pad);
  const x1 = Math.round((bounds.x0 + (bounds.x1 - bounds.x0) * (col + 1) / cols) * W - cellW * pad);
  const y0 = Math.round((bounds.y0 + (bounds.y1 - bounds.y0) * row / rows) * H + cellH * pad);
  const y1 = Math.round((bounds.y0 + (bounds.y1 - bounds.y0) * (row + 1) / rows) * H - cellH * pad);
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  const ctx = source.getContext('2d', { willReadFrequently: true })!;
  const im = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const trimmed = trimInkCell(im.data, im.width, im.height);
  if (!trimmed) return null;
  return { ...trimmed, row, col, inset };
}

function guessedPair(cell: PreparedCell, char: string, side: Side): Pair {
  const baseline = cell.bbox[3];
  const xh = Math.max(12, cell.bbox[3] - cell.bbox[1]);
  const level = side === 'entry' ? entryLevel(char) : exitLevel(char);
  const y = clamp(baseline - (level === 'high' ? .78 : .12) * xh, cell.bbox[1], cell.bbox[3]);
  const depth = Math.max(2, Math.min(cell.width * .18, 10));
  const x0 = side === 'entry' ? cell.bbox[0] : cell.bbox[2] - 1;
  const x1 = clamp(side === 'entry' ? x0 + depth : x0 - depth, 0, cell.width - 1);
  return { p0: [x0, y], p1: [x1, y] };
}

function makeJoint(pair: Pair, level: Joint['level']): Joint | null {
  if (!pair.p0 || !pair.p1) return null;
  return { kind: 'end', level, p0: pair.p0, p1: pair.p1, width: 5, conf: 1 };
}

function JointEditor({ cell, char, onChar, onInset, onSave, onClose }: { cell: PreparedCell; char: string; onChar: (s: string) => void; onInset: (n: number) => void; onSave: (entry: Joint | null, exit: Joint | null, baseline: number, xHeight: number) => void; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState<Side>('entry');
  const [entry, setEntry] = useState<Pair>(() => guessedPair(cell, char, 'entry'));
  const [exit, setExit] = useState<Pair>(() => guessedPair(cell, char, 'exit'));
  const [baseline, setBaseline] = useState(cell.bbox[3]);
  const [xHeight, setXHeight] = useState(clamp(cell.bbox[3] - cell.bbox[1], 1, cell.height));
  useEffect(() => {
    setEntry(guessedPair(cell, char, 'entry')); setExit(guessedPair(cell, char, 'exit'));
    setBaseline(cell.bbox[3]); setXHeight(clamp(cell.bbox[3] - cell.bbox[1], 1, cell.height));
  }, [cell.width, cell.height, cell.inset, char]);
  const pairs = { entry, exit };
  const isCyrillic = isJoining(char);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cell.width; canvas.height = cell.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(cell.rgba), cell.width, cell.height), 0, 0);
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(220,0,0,.8)';
    ctx.beginPath(); ctx.moveTo(0, baseline); ctx.lineTo(cell.width, baseline); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,150,0,.8)'; ctx.beginPath(); ctx.moveTo(0, baseline - xHeight); ctx.lineTo(cell.width, baseline - xHeight); ctx.stroke(); ctx.setLineDash([]);
    if (isCyrillic) for (const [p, color, label] of [[entry, '#1672e8', 'вход'], [exit, '#df5a1f', 'выход']] as const) {
      if (!p.p0) continue;
      const end = p.p1 ?? p.p0;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1.5, cell.width / 80);
      ctx.beginPath(); ctx.moveTo(...p.p0); ctx.lineTo(...end); ctx.stroke();
      if (p.p1) {
        const a = Math.atan2(end[1] - p.p0[1], end[0] - p.p0[0]); const len = Math.max(4, cell.width / 18);
        ctx.beginPath(); ctx.moveTo(...end); ctx.lineTo(end[0] - len * Math.cos(a - .45), end[1] - len * Math.sin(a - .45)); ctx.lineTo(end[0] - len * Math.cos(a + .45), end[1] - len * Math.sin(a + .45)); ctx.closePath(); ctx.fill();
      }
      for (const [idx, point] of [p.p0, p.p1].entries()) if (point) {
        ctx.beginPath(); ctx.arc(point[0], point[1], Math.max(3, cell.width / 35), 0, Math.PI * 2); ctx.fill();
        ctx.fillText(`${label} ${idx + 1}`, point[0] + 4, point[1] - 4);
      }
    }
  }, [cell, entry, exit, isCyrillic, baseline, xHeight]);
  function tap(e: PointerEvent<HTMLCanvasElement>) {
    if (!isCyrillic) return;
    const c = e.currentTarget, r = c.getBoundingClientRect();
    const point: [number, number] = [clamp((e.clientX - r.left) * c.width / r.width, 0, c.width - 1), clamp((e.clientY - r.top) * c.height / r.height, 0, c.height - 1)];
    const cur = pairs[side];
    const next = !cur.p0 || cur.p1 ? { p0: point, p1: null } : { ...cur, p1: point };
    (side === 'entry' ? setEntry : setExit)(next);
  }
  return <div className="modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="editor-modal" role="dialog" aria-modal="true" aria-label="Проверка буквы">
      <div className="row wrap"><strong>Клетка {cell.row + 1}×{cell.col + 1}</strong><button className="btn small" onClick={onClose}>Закрыть</button></div>
      <label className="field">Распознанный символ — проверьте и исправьте
        <input value={char} maxLength={2} onChange={(e) => onChar([...e.target.value].slice(-1).join(''))} autoFocus />
      </label>
      <label className="field">Подрезать клетку сильнее: {cell.inset}% от каждого края<input type="range" min={0} max={25} value={cell.inset} onChange={(e) => onInset(Number(e.target.value))} /></label>
      <label className="field">Линия строки — красная: {baseline.toFixed(0)} px<input type="range" min={0} max={cell.height} value={baseline} onChange={(e) => setBaseline(Number(e.target.value))} /></label>
      <label className="field">Высота строчных — зелёная: {xHeight.toFixed(0)} px<input type="range" min={1} max={cell.height} value={clamp(xHeight, 1, cell.height)} onChange={(e) => setXHeight(Number(e.target.value))} /></label>
      {isCyrillic && <>
        <div className="row wrap"><button className={`btn small ${side === 'entry' ? 'primary' : ''}`} onClick={() => setSide('entry')}>Вход пера: 2 точки</button><button className={`btn small ${side === 'exit' ? 'primary' : ''}`} onClick={() => setSide('exit')}>Выход пера: 2 точки</button><button className="btn small" onClick={() => side === 'entry' ? setEntry(guessedPair(cell, char, side)) : setExit(guessedPair(cell, char, side))}>Вернуть оценку</button></div>
        <p className="meta">Синие и оранжевые стрелки — начальная оценка по краям буквы, проверьте их. Коснитесь штриха у края буквы, затем глубже внутри неё, чтобы заменить две точки. Эти векторы нужно проверить: в клетке буква изолирована.</p>
      </>}
      <div className="joint-canvas"><canvas ref={canvasRef} onPointerDown={tap} /></div>
      <div className="row"><button className="btn primary" disabled={[...char].length !== 1 || (isCyrillic && (!entry.p0 || !entry.p1 || !exit.p0 || !exit.p1))} onClick={() => onSave(isCyrillic ? makeJoint(entry, entryLevel(char)) : null, isCyrillic ? makeJoint(exit, exitLevel(char)) : null, baseline, xHeight)}>Применить и сохранить</button></div>
    </div>
  </div>;
}

export function Worksheet({ glyphs, setGlyphs, ocrReady }: { glyphs: StoredGlyph[]; setGlyphs: (g: StoredGlyph[]) => void; ocrReady: boolean }) {
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [name, setName] = useState('');
  const [rows, setRows] = useState(10);
  const [cols, setCols] = useState(10);
  const [bounds, setBounds] = useState<Bounds>(INITIAL_BOUNDS);
  const [inset, setInset] = useState(8);
  const [cells, setCells] = useState<PreparedCell[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dragRef = useRef<number | null>(null);
  const pdfRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const index = (r: number, c: number) => r * cols + c;
  const activeCell = active === null ? null : cells[active];

  useEffect(() => {
    const canvas = displayRef.current;
    if (!canvas || !source) return;
    canvas.width = source.width; canvas.height = source.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0);
    ctx.strokeStyle = 'rgba(20,115,210,.9)'; ctx.lineWidth = Math.max(1.5, source.width / 1000);
    for (let i = 0; i <= cols; i++) { const x = (bounds.x0 + (bounds.x1 - bounds.x0) * i / cols) * source.width; ctx.beginPath(); ctx.moveTo(x, bounds.y0 * source.height); ctx.lineTo(x, bounds.y1 * source.height); ctx.stroke(); }
    for (let i = 0; i <= rows; i++) { const y = (bounds.y0 + (bounds.y1 - bounds.y0) * i / rows) * source.height; ctx.beginPath(); ctx.moveTo(bounds.x0 * source.width, y); ctx.lineTo(bounds.x1 * source.width, y); ctx.stroke(); }
    const corners: [number, number][] = [[bounds.x0, bounds.y0], [bounds.x1, bounds.y0], [bounds.x1, bounds.y1], [bounds.x0, bounds.y1]];
    ctx.fillStyle = '#e43b32';
    for (const [x, y] of corners) { ctx.beginPath(); ctx.arc(x * source.width, y * source.height, Math.max(9, source.width / 90), 0, Math.PI * 2); ctx.fill(); }
  }, [source, rows, cols, bounds]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);
  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) void videoRef.current.play().catch(() => undefined);
  }, [cameraOpen]);

  async function openCamera() {
    setMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream; setCameraOpen(true);
    } catch (e) { setMessage(`Не удалось открыть камеру: ${e instanceof Error ? e.message : String(e)}. Разрешите доступ к камере или загрузите фото/PDF.`); }
  }
  function closeCamera() { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCameraOpen(false); }
  function captureCamera() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const f = Math.min(1, 2400 / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas'); c.width = Math.round(video.videoWidth * f); c.height = Math.round(video.videoHeight * f);
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
    setName('камера'); setSource(c); setBounds(INITIAL_BOUNDS); setCells([]); setMessage('Кадр получен. Потяните четыре красные точки по углам области клеток.'); closeCamera();
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setBusy('загрузка документа…'); setMessage(''); setCells([]); setPdfPages(0); pdfRef.current = null;
    try {
      let canvas: HTMLCanvasElement;
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data }).promise;
        pdfRef.current = doc; setPdfPages(doc.numPages); setPdfPage(1);
        canvas = await renderPdfPage(doc, 1);
      } else {
        const img = await decodeImageFile(file, 4096);
        canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
      }
      setName(file.name); setSource(canvas); setBounds(INITIAL_BOUNDS);
      setMessage('Подвиньте красные углы к границам сетки. Сетка здесь — подсказка поверх снимка, файл не изменяется.');
    } catch (e) { setMessage(`Не удалось открыть файл: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(''); }
  }

  async function changePdfPage(page: number) {
    const doc = pdfRef.current;
    if (!doc) return;
    const n = clamp(Math.round(page), 1, doc.numPages);
    setBusy(`страница PDF ${n}…`);
    try { setSource(await renderPdfPage(doc, n)); setPdfPage(n); setCells([]); setBounds(INITIAL_BOUNDS); }
    catch (e) { setMessage(`Не удалось отрисовать страницу: ${String(e)}`); }
    finally { setBusy(''); }
  }

  function pointerPoint(e: PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  function startDrag(e: PointerEvent<HTMLCanvasElement>) {
    if (!source) return;
    const p = pointerPoint(e);
    const rect = e.currentTarget.getBoundingClientRect();
    const points: [number, number][] = [[bounds.x0, bounds.y0], [bounds.x1, bounds.y0], [bounds.x1, bounds.y1], [bounds.x0, bounds.y1]];
    const d = points.map(([x, y]) => Math.hypot((x - p.x) * rect.width, (y - p.y) * rect.height));
    const nearest = Math.min(...d);
    if (nearest < 32) { dragRef.current = d.indexOf(nearest); e.currentTarget.setPointerCapture(e.pointerId); }
  }
  function moveDrag(e: PointerEvent<HTMLCanvasElement>) {
    if (dragRef.current === null || !source) return;
    const p = pointerPoint(e), n = dragRef.current;
    setBounds((b) => {
      const x = clamp(p.x, .01, .99), y = clamp(p.y, .01, .99);
      const next = { ...b };
      if (n === 0) { next.x0 = Math.min(x, b.x1 - .08); next.y0 = Math.min(y, b.y1 - .08); }
      if (n === 1) { next.x1 = Math.max(x, b.x0 + .08); next.y0 = Math.min(y, b.y1 - .08); }
      if (n === 2) { next.x1 = Math.max(x, b.x0 + .08); next.y1 = Math.max(y, b.y0 + .08); }
      if (n === 3) { next.x0 = Math.min(x, b.x1 - .08); next.y1 = Math.max(y, b.y0 + .08); }
      return next;
    });
  }

  async function buildCells() {
    if (!source) return;
    setBusy('подготовка клеток…'); setCells([]); setMessage('');
    const found: PreparedCell[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = prepareCell(source, rows, cols, bounds, r, c, inset);
      if (!cell) continue;
      // OCR uses a paper-coloured image; the saved PNG retains transparent background.
      const result: PreparedCell = { ...cell, char: '', confidence: 0 };
      if (ocrReady) {
        try {
          const read = await call('readCell', { rgba: whitePaper(cell.rgba), width: cell.width, height: cell.height });
          const graphemes = [...read.text.replace(/\s/g, '')];
          result.char = graphemes.length === 1 ? graphemes[0] : '';
          result.confidence = read.confidence;
        } catch { /* a failed cell remains editable */ }
      }
      found.push(result);
      setBusy(`клетки: ${found.length} обработано`);
    }
    setCells(found); setBusy('');
    setMessage(`Найдено ячеек с чернилами: ${found.length}. Проверьте подписи, исправьте обрезку и точки, затем добавьте буквы в библиотеку.`);
  }

  function setCellChar(k: number, char: string) {
    setCells((all) => all.map((c, i) => i === k ? { ...c, char } : c));
  }
  function updateInset(k: number, value: number) {
    const old = cells[k];
    if (!source) return;
    const next = prepareCell(source, rows, cols, bounds, old.row, old.col, value);
    if (!next) return;
    setCells((all) => all.map((c, i) => i === k ? { ...next, char: c.char, confidence: 0 } : c));
  }
  async function saveGridPreview() {
    const preview = displayRef.current;
    if (!preview) return;
    const blob = await new Promise<Blob>((resolve, reject) => preview.toBlob((b) => b ? resolve(b) : reject(new Error('Не удалось сохранить превью')), 'image/png'));
    setMessage(await saveFile('worksheet-grid.png', new Uint8Array(await blob.arrayBuffer()), 'image/png'));
  }

  async function saveCell(k: number, entry: Joint | null, exit: Joint | null, baseline: number, xHeight: number) {
    const c = cells[k];
    const chars = [...c.char.trim()];
    if (chars.length !== 1) return;
    const id = newId();
    const variant = glyphs.filter((g) => g.meta.char === chars[0]).reduce((m, g) => Math.max(m, g.meta.variant), 0) + 1;
    const xh = Math.max(12, c.bbox[3] - c.bbox[1]);
    const meta: GlyphMeta = {
      schema: 2, id, char: chars[0], variant, position: 'isolated', prev: '', next: '', width: c.width, height: c.height,
      bbox: c.bbox, baseline: clamp(baseline, 0, c.height), x_height: clamp(xHeight, 1, c.height), stroke_width: Math.max(1.5, xHeight / 10), slant: 0, ink_rgb: [32, 43, 86],
      entry, exit, left_joint: entry?.p0, right_joint: exit?.p0,
      source: { file: name, line: c.row, index: c.col, px_per_mm: null },
      quality: { cost: 0, auto: false, read: c.char, p: c.confidence }, enabled: true, checked_by_user: true,
    };
    const item: StoredGlyph = { id, meta, png: encodePng(c.rgba, c.width, c.height) };
    await dbPutMany([item]); setGlyphs([...glyphs, item]);
    setCells((all) => all.map((cell, i) => i === k ? { ...cell, saved: true } : cell));
    setMessage(`«${chars[0]}» сохранена в библиотеку.`); setActive(null);
  }

  async function saveAllEnglishAndMarked() {
    // A convenience for already-verified printed Latin/digit cells; Cyrillic still requires hand-marked vectors.
    const eligible = cells.filter((c) => !c.saved && [...c.char.trim()].length === 1 && !isJoining(c.char));
    const counters = new Map<string, number>();
    for (const g of glyphs) counters.set(g.meta.char, Math.max(counters.get(g.meta.char) ?? 0, g.meta.variant));
    const items: StoredGlyph[] = eligible.map((c) => {
      const id = newId();
      const variant = (counters.get(c.char) ?? 0) + 1; counters.set(c.char, variant);
      const xh = Math.max(12, c.bbox[3] - c.bbox[1]);
      const meta: GlyphMeta = { schema: 2, id, char: c.char, variant, position: 'isolated', prev: '', next: '', width: c.width, height: c.height, bbox: c.bbox, baseline: c.bbox[3], x_height: xh, stroke_width: Math.max(1.5, xh / 10), slant: 0, ink_rgb: [32, 43, 86], entry: null, exit: null, source: { file: name, line: c.row, index: c.col, px_per_mm: null }, quality: { cost: 0, auto: false, read: c.char, p: c.confidence }, enabled: true, checked_by_user: true };
      return { id, meta, png: encodePng(c.rgba, c.width, c.height) };
    });
    await dbPutMany(items); setGlyphs([...glyphs, ...items]);
    const savedCells = new Set(eligible.map((c) => `${c.row}-${c.col}`));
    setCells((all) => all.map((c) => savedCells.has(`${c.row}-${c.col}`) ? { ...c, saved: true } : c));
    setMessage(`Добавлено ${items.length} латинских букв, цифр и знаков. Русские буквы добавляйте из редактора после отметки векторов.`);
  }

  const validCount = useMemo(() => cells.filter((c) => [...c.char.trim()].length === 1).length, [cells]);

  return <section className="worksheet">
    <div className="card worksheet-intro">
      <h3>Сбор по клеткам — вручную с подсказками</h3>
      <p className="hint">Распечатайте лист с сеткой или нарисуйте её сами: одна изолированная буква, цифра или знак в каждой клетке. Камера показывает сетку поверх живого изображения; после снимка можно двигать углы и менять размер таблицы. OCR работает на устройстве и только предлагает подпись — всё можно исправить вручную.</p>
      <div className="row wrap">
        <button className="btn primary" onClick={() => void openCamera()}>Открыть камеру с сеткой</button>
        <label className="btn">Фото<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <label className="btn">Рисунок или PDF<input type="file" accept="image/*,.pdf,application/pdf" hidden onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>
      {pdfPages > 1 && <label className="field small">Страница PDF<input type="number" min={1} max={pdfPages} value={pdfPage} onChange={(e) => void changePdfPage(Number(e.target.value))} /></label>}
      <div className="grid">
        <label className="field small">Строк в таблице<input type="number" min={1} max={40} value={rows} onChange={(e) => setRows(clamp(Number(e.target.value) || 1, 1, 40))} /></label>
        <label className="field small">Клеток в строке<input type="number" min={1} max={40} value={cols} onChange={(e) => setCols(clamp(Number(e.target.value) || 1, 1, 40))} /></label>
        <label className="field small">Отступ от линий сетки: {inset}%<input type="range" min={0} max={25} value={inset} onChange={(e) => setInset(Number(e.target.value))} /></label>
      </div>
      <p className="meta">Обычно 10×10; число строк и столбцов можно менять. Синие линии показывают клетки, красные углы передвигаются касанием. Отступ помогает не захватить напечатанные линии.</p>
      {source && <>
        <div className="worksheet-preview"><canvas ref={displayRef} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} /></div>
        <div className="row wrap"><button className="btn primary" disabled={!!busy} onClick={() => void buildCells()}>Распознать клетки локально</button><button className="btn" onClick={() => void saveGridPreview()}>Сохранить превью с сеткой</button></div>
      </>}
      {busy && <p className="busy">{busy}</p>}{message && <p className="meta">{message}</p>}
    </div>
    {!!cells.length && <div className="card">
      <div className="row wrap"><strong>Проверка клеток: {validCount} подписано из {cells.length}</strong><button className="btn small" disabled={!cells.some((c) => !c.saved && [...c.char.trim()].length === 1 && !isJoining(c.char))} onClick={() => void saveAllEnglishAndMarked()}>Добавить латиницу, цифры и знаки</button></div>
      <p className="meta">Нажмите клетку, исправьте распознавание и при необходимости сильнее измените обрезку. Для каждой русской буквы редактор попросит отметить две точки входа и две выхода.</p>
      <div className="worksheet-cells">{cells.map((c, k) => <div key={`${c.row}-${c.col}`} className={`worksheet-cell ${c.char ? 'has-char' : ''} ${c.saved ? 'saved' : ''}`}>
        <span className="worksheet-index">{c.row + 1}:{c.col + 1}</span><strong>{c.char || '·'}</strong><small>{c.saved ? 'в библиотеке' : c.confidence ? `${Math.round(c.confidence * 100)}%` : 'проверьте'}</small>
        <button className="btn small" onClick={() => setActive(k)}>{c.saved ? 'Ещё вариант' : 'Проверить / сохранить'}</button>
      </div>)}</div>
    </div>}
    {cameraOpen && <div className="camera-sheet"><div className="row wrap"><strong>Камера: выровняйте лист по сетке</strong><button className="btn small" onClick={closeCamera}>Закрыть</button></div><div className="camera-view"><video ref={videoRef} playsInline muted /><svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect x="3" y="3" width="94" height="94" fill="none" stroke="#ffcc00" strokeWidth=".7" />{Array.from({ length: cols - 1 }, (_, i) => <line key={`v${i}`} x1={3 + 94 * (i + 1) / cols} x2={3 + 94 * (i + 1) / cols} y1="3" y2="97" stroke="#ffcc00" strokeWidth=".35" />)}{Array.from({ length: rows - 1 }, (_, i) => <line key={`h${i}`} x1="3" x2="97" y1={3 + 94 * (i + 1) / rows} y2={3 + 94 * (i + 1) / rows} stroke="#ffcc00" strokeWidth=".35" />)}</svg></div><p className="meta">Сетка — визуальная подсказка камеры. Чтобы клетки распознались ровно, на бумаге тоже должна быть сетка.</p><button className="btn primary" onClick={captureCamera}>Снять кадр</button></div>}
    {activeCell && active !== null && <JointEditor cell={activeCell} char={activeCell.char} onChar={(char) => setCellChar(active, char)} onInset={(value) => updateInset(active, value)} onClose={() => setActive(null)} onSave={(entry, exit, baseline, xHeight) => void saveCell(active, entry, exit, baseline, xHeight)} />}
  </section>;
}

async function renderPdfPage(doc: pdfjs.PDFDocumentProxy, pageNumber: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 2200 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, background: 'rgb(255,255,255)' }).promise;
  return canvas;
}
