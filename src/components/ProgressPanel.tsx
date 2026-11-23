import { ALL_CHARS, GROUPS } from '../core/charset';
import type { GlyphData, Slot } from '../core/glyph';
import { slotId } from '../core/glyph';
import type { Completeness } from '../core/zip';

interface Props {
  queue: Slot[];
  glyphs: Record<string, GlyphData>;
  completeness: Completeness;
  variants: number;
  onJump: (slotIndex: number) => void;
  onClose: () => void;
}

const groupOf = (ch: string) => GROUPS.find((g) => g.chars.includes(ch));

/** Обзор заполненности: по каждому символу видно, сколько вариантов уже нарисовано. Тап — переход к первому пустому. */
export function ProgressPanel({ queue, glyphs, completeness, variants, onJump, onClose }: Props) {
  const firstMissing = (ch: string): number => {
    const slot = queue.find((s) => s.char === ch && !glyphs[slotId(s.char, s.variant)]);
    return slot ? slot.index : queue.find((s) => s.char === ch)!.index;
  };

  return (
    <div className="overlay">
      <div className="overlay-card wide">
        <div className="overlay-head">
          <strong>
            Заполнено: {completeness.filled} / {completeness.total}
            {completeness.complete ? ' — всё готово к экспорту!' : ''}
          </strong>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="progress-bar">
          <div style={{ width: `${completeness.total ? (completeness.filled / completeness.total) * 100 : 0}%` }} />
        </div>
        {GROUPS.map((g) => (
          <div key={g.id} className="progress-group">
            <h3>{g.title}</h3>
            <div className="chips">
              {[...g.chars].map((ch) => {
                const filled = Array.from({ length: variants }, (_, i) => glyphs[slotId(ch, i + 1)]).filter(Boolean).length;
                const done = filled === variants;
                return (
                  <button
                    key={ch}
                    className={done ? 'chip done' : filled > 0 ? 'chip partial' : 'chip'}
                    onClick={() => onJump(firstMissing(ch))}
                    title={`${ch}: ${filled}/${variants}`}
                  >
                    <span className="chip-char">{ch}</span>
                    <span className="chip-dots">{'●'.repeat(filled)}{'○'.repeat(variants - filled)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <p className="hint">
          Всего символов: {ALL_CHARS.length}, вариантов каждого: {variants}. Нажатие на символ переносит к его первому незаполненному варианту.
        </p>
        <div className="overlay-actions">
          <button className="primary" onClick={onClose}>
            К рисованию
          </button>
        </div>
      </div>
    </div>
  );
}
