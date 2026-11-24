import type { Settings } from '../core/store';
import { fieldMm, mmToPx } from '../core/glyph';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onResetAll: () => void;
  onClose: () => void;
}

function Row(props: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  valueNum: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="setting-row">
      <span>
        {props.label} <b>{props.value}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.valueNum}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

export function SettingsPanel({ settings, onChange, onResetAll, onClose }: Props) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const field = fieldMm(settings.cellMm, settings.fieldCells);
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-head">
          <strong>Настройки</strong>
          <button onClick={onClose}>✕</button>
        </div>

        <Row
          label="Размер клетки (минимум 5 мм, поле всегда 3×3)"
          value={`${settings.cellMm} мм (поле ${field} мм)`}
          min={5}
          max={12}
          step={0.5}
          valueNum={settings.cellMm}
          onChange={(v) => set({ cellMm: v })}
        />
        <Row
          label="Клеток на экране по горизонтали"
          value={`${settings.cols}`}
          min={1}
          max={6}
          step={1}
          valueNum={settings.cols}
          onChange={(v) => set({ cols: Math.round(v) })}
        />
        <Row
          label="Клеток на экране по вертикали"
          value={`${settings.rows}`}
          min={1}
          max={6}
          step={1}
          valueNum={settings.rows}
          onChange={(v) => set({ rows: Math.round(v) })}
        />
        <Row
          label="Толщина штриха на экране"
          value={`${settings.strokeWidth} px`}
          min={1}
          max={5}
          step={0.5}
          valueNum={settings.strokeWidth}
          onChange={(v) => set({ strokeWidth: v })}
        />
        <Row
          label="Вариантов каждого символа (от 1 до 8)"
          value={`${settings.variants}`}
          min={1}
          max={8}
          step={1}
          valueNum={settings.variants}
          onChange={(v) => set({ variants: Math.round(v) })}
        />

        <label className="setting-check">
          <input type="checkbox" checked={settings.showGuides} onChange={(e) => set({ showGuides: e.target.checked })} />
          Показывать сетку клеток
        </label>

        <p className="hint">
          Поле на экране: {Math.round(mmToPx(field))}×{Math.round(mmToPx(field))} px при реальном масштабе. Размер холста в данных всегда
          600×600 — настройки не меняют сохранённые координаты. Строчная буква вписывается в центральную клетку: её низ — на нижней
          линии, верх — на верхней.
        </p>

        <div className="overlay-actions">
          <button onClick={onClose}>Готово</button>
          <button
            className="danger"
            onClick={() => {
              if (window.confirm('Удалить ВСЕ нарисованные глифы и начать сначала?')) onResetAll();
            }}
          >
            Сбросить всё
          </button>
        </div>
      </div>
    </div>
  );
}
