import { useEffect, useRef, useState } from 'react';
import { CANVAS_H, CANVAS_W, type Anchors, type GlyphData, type Point } from '../core/glyph';
import { drawCanvas, getAnchor, setAnchor, type AnchorKey } from '../core/draw';

interface Props {
  glyph: GlyphData;
  displayPx: number;
  fieldCells: number;
  strokeWidth: number;
  showGuides: boolean;
  onSave: (anchors: Anchors) => void;
  onClose: () => void;
}

const ANCHOR_LABELS: { key: AnchorKey; label: string }[] = [
  { key: 'entryMain', label: 'Вход' },
  { key: 'entryHandle', label: 'Вход²' },
  { key: 'exitMain', label: 'Выход' },
  { key: 'exitHandle', label: 'Выход²' },
];

/**
 * Редактор анкеров для одного глифа (принцип «Зафиксировать» из HTML-редактора):
 * точки входа/выхода перетаскиваются пальцем, вводятся координатами или сдвигаются кнопками.
 */
export function AnchorEditor({ glyph, displayPx, fieldCells, strokeWidth, showGuides, onSave, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [anchors, setAnchors] = useState<Anchors>(glyph.anchors);
  const [selected, setSelected] = useState<AnchorKey>('entryMain');
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const dragRef = useRef<AnchorKey | null>(null);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawCanvas(ctx, {
      fieldCells,
      showGuides,
      strokeWidth,
      displayPx,
      path: glyph.path,
      anchors: anchorsRef.current,
      selectedAnchor: selectedRef.current,
      // в редакторе видны все линии: сетка, уровни, поля и связи точек
      mode: 'full',
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(CANVAS_W * dpr);
    canvas.height = Math.round(CANVAS_H * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPx, fieldCells, strokeWidth, showGuides, anchors, selected]);

  const getPos = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const nearestAnchor = (p: Point): AnchorKey | null => {
    let best: AnchorKey | null = null;
    // порог касания — 28 экранных пикселей, в логических единицах
    let bestDist = 28 * (CANVAS_W / displayPx);
    for (const { key } of ANCHOR_LABELS) {
      const a = getAnchor(anchorsRef.current, key);
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bestDist) {
        bestDist = d;
        best = key;
      }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const key = nearestAnchor(getPos(e));
    if (key) {
      dragRef.current = key;
      setSelected(key);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const p = getPos(e);
    setAnchors(setAnchor(anchorsRef.current, dragRef.current, { x: Math.round(p.x), y: Math.round(p.y) }));
  };

  const onUp = () => {
    dragRef.current = null;
  };

  const point = getAnchor(anchors, selected);
  const setCoord = (axis: 'x' | 'y', value: string) => {
    const v = parseFloat(value);
    if (Number.isNaN(v)) return;
    setAnchors(setAnchor(anchors, selected, { ...point, [axis]: Math.round(v) }));
  };
  const nudge = (dx: number, dy: number) =>
    setAnchors(setAnchor(anchors, selected, { x: point.x + dx, y: point.y + dy }));

  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-head">
          <strong>
            «{glyph.char}» — точки входа/выхода
          </strong>
          <button onClick={onClose}>✕</button>
        </div>
        <canvas
          ref={canvasRef}
          className="cell-canvas editor-canvas"
          style={{ width: displayPx, height: displayPx, touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        <div className="anchor-panel">
          <div className="anchor-selector">
            {ANCHOR_LABELS.map(({ key, label }) => (
              <button key={key} className={selected === key ? 'anchor-label active' : 'anchor-label'} onClick={() => setSelected(key)}>
                {label}
              </button>
            ))}
          </div>
          <div className="coord-inputs">
            <label>
              X <input type="number" value={point.x} onChange={(e) => setCoord('x', e.target.value)} />
            </label>
            <label>
              Y <input type="number" value={point.y} onChange={(e) => setCoord('y', e.target.value)} />
            </label>
          </div>
          <div className="nudge-buttons">
            <span />
            <button onClick={() => nudge(0, -1)}>↑</button>
            <span />
            <button onClick={() => nudge(-1, 0)}>←</button>
            <button onClick={() => nudge(0, 1)}>↓</button>
            <button onClick={() => nudge(1, 0)}>→</button>
          </div>
        </div>
        <div className="overlay-actions">
          <button className="primary" onClick={() => onSave(anchors)}>
            Сохранить точки
          </button>
          <button onClick={onClose}>Отмена</button>
        </div>
        <p className="hint">Точку можно перетащить пальцем прямо на холсте.</p>
      </div>
    </div>
  );
}
