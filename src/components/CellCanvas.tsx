import { useEffect, useRef } from 'react';
import { CANVAS_H, CANVAS_W, strokeToGlyph, type GlyphData, type Point } from '../core/glyph';
import { drawCanvas } from '../core/draw';

interface Props {
  char: string;
  glyph: GlyphData | null;
  /** CSS-размер холста в пикселях (по миллиметрам из настроек). */
  displayPx: number;
  fieldCells: number;
  strokeWidth: number;
  showGuides: boolean;
  onStroke: (glyph: GlyphData) => void;
  onTooShort: () => void;
}

/** Одна клетка: холст, на котором рисуют один штрих. Анкеры определяются автоматически. */
export function CellCanvas({ char, glyph, displayPx, fieldCells, strokeWidth, showGuides, onStroke, onTooShort }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rawRef = useRef<Point[]>([]);
  const drawingRef = useRef(false);
  const glyphRef = useRef(glyph);
  glyphRef.current = glyph;

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const path = drawingRef.current ? rawRef.current : (glyphRef.current?.path ?? []);
    drawCanvas(ctx, {
      fieldCells,
      showGuides,
      strokeWidth,
      path,
      anchors: drawingRef.current ? null : (glyphRef.current?.anchors ?? null),
      selectedAnchor: null,
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
  }, [displayPx, fieldCells, strokeWidth, showGuides, glyph]);

  const getPos = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    rawRef.current = [getPos(e)];
    draw();
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    rawRef.current.push(getPos(e));
    draw();
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    const result = strokeToGlyph(char, rawRef.current);
    rawRef.current = [];
    if (result) onStroke(result);
    else onTooShort();
    draw();
  };

  return (
    <canvas
      ref={canvasRef}
      className="cell-canvas"
      style={{ width: displayPx, height: displayPx, touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}
