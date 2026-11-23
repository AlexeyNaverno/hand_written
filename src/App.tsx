import { useEffect, useMemo, useRef, useState } from 'react';
import { ALL_CHARS, GROUPS } from './core/charset';
import { batchSlots, buildQueue, fieldMm, mmToPx, slotId, type GlyphData, type Slot } from './core/glyph';
import { clearAllData, emptyState, loadState, saveState, saveStateNow, type AppState, type Settings } from './core/store';
import { buildZip, completeness } from './core/zip';
import { saveFile } from './platform';
import { CellCanvas } from './components/CellCanvas';
import { AnchorEditor } from './components/AnchorEditor';
import { SettingsPanel } from './components/SettingsPanel';
import { ProgressPanel } from './components/ProgressPanel';

type View = 'write' | 'settings' | 'progress';

const groupOf = (ch: string) => {
  const g = GROUPS.find((gr) => gr.chars.includes(ch));
  return { id: g?.id ?? 'other', title: g?.title ?? 'Прочее' };
};

export function App() {
  const [state, setState] = useState<AppState>(() => emptyState());
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>('write');
  const [editorSlot, setEditorSlot] = useState<Slot | null>(null);
  const [status, setStatus] = useState('Нарисуйте букву одним штрихом в клетке');
  const [exporting, setExporting] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    loadState().then((s) => {
      stateRef.current = s;
      setState(s);
      setLoaded(true);
    });
  }, []);

  const commit = (next: AppState) => {
    stateRef.current = next;
    setState(next);
    saveState(next);
  };

  const queue = useMemo(
    () => buildQueue(ALL_CHARS, groupOf, state.settings.variants),
    [state.settings.variants],
  );
  const done = useMemo(() => completeness(queue, state.glyphs), [queue, state.glyphs]);

  const batchSize = state.settings.cols * state.settings.rows;
  const cursor = Math.max(0, Math.min(state.cursor, Math.max(0, queue.length - 1)));
  const slots = batchSlots(queue, cursor, batchSize);
  const displayPx = mmToPx(fieldMm(state.settings.cellMm, state.settings.fieldCells));
  const isLastScreen = cursor + batchSize >= queue.length;
  const firstSlot = slots[0];
  const lastSlot = slots[slots.length - 1];

  const onStroke = (slot: Slot, glyph: GlyphData) => {
    const s = stateRef.current;
    commit({ ...s, glyphs: { ...s.glyphs, [slotId(slot.char, slot.variant)]: glyph } });
    setStatus(`«${slot.char}», вариант ${slot.variant} — сохранено ✓`);
  };

  const onClear = (slot: Slot) => {
    const s = stateRef.current;
    const glyphs = { ...s.glyphs };
    delete glyphs[slotId(slot.char, slot.variant)];
    commit({ ...s, glyphs });
    setStatus(`«${slot.char}», вариант ${slot.variant} — клетка очищена`);
  };

  const onClearScreen = () => {
    const s = stateRef.current;
    const glyphs = { ...s.glyphs };
    for (const slot of slots) delete glyphs[slotId(slot.char, slot.variant)];
    commit({ ...s, glyphs });
    setStatus('Все клетки на экране очищены');
  };

  const onNext = () => {
    const s = stateRef.current;
    // сохранение именно по нажатию «Следующий» — немедленно и надёжно
    void saveStateNow(s).then(() => {
      if (isLastScreen) {
        setStatus(
          done.complete
            ? 'Все символы заполнены! Можно экспортировать ZIP.'
            : `Последний экран сохранён. Осталось заполнить: ${done.missing.length}. Откройте «Обзор», чтобы перейти к пропущенным.`,
        );
      } else {
        setStatus('Сохранено ✓. Следующий экран.');
      }
    });
    if (!isLastScreen) commit({ ...s, cursor: cursor + batchSize });
  };

  const onBack = () => {
    const s = stateRef.current;
    void saveStateNow(s);
    commit({ ...s, cursor: Math.max(0, cursor - batchSize) });
    setStatus('Сохранено ✓. Предыдущий экран — варианты можно перерисовать.');
  };

  const onJump = (slotIndex: number) => {
    const s = stateRef.current;
    void saveStateNow(s);
    commit({ ...s, cursor: Math.floor(slotIndex / batchSize) * batchSize });
    setView('write');
    setStatus('Переход к выбранному символу. Нарисованное можно перерисовать.');
  };

  const onSettings = (settings: Settings) => {
    const s = stateRef.current;
    commit({ ...s, settings, cursor: Math.min(s.cursor, Math.max(0, queue.length - 1)) });
  };

  const onResetAll = () => {
    void clearAllData().then(() => {
      const s = stateRef.current;
      commit({ ...emptyState(), settings: s.settings });
      setView('write');
      setStatus('Все данные очищены. Начинаем сначала.');
    });
  };

  const onExport = async () => {
    if (!done.complete || exporting) return;
    setExporting(true);
    try {
      const bytes = buildZip(queue, stateRef.current.glyphs);
      const msg = await saveFile('pocherk-glyphs.zip', bytes, 'application/zip');
      setStatus(msg);
    } catch (err) {
      setStatus(`Ошибка экспорта: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const editorGlyph = editorSlot ? state.glyphs[slotId(editorSlot.char, editorSlot.variant)] : null;

  if (!loaded) return <div className="loading">Загрузка…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <strong>Почерк — буквы</strong>
          <span>
            {done.filled}/{done.total}
            {done.complete ? ' · всё готово!' : ''}
          </span>
        </div>
        <div className="topbar-actions">
          <button onClick={() => setView('progress')}>Обзор</button>
          <button onClick={() => setView('settings')}>⚙</button>
          <button
            className="primary"
            disabled={!done.complete || exporting}
            title={done.complete ? 'Скачать ZIP со всеми глифами' : `Экспорт после заполнения всех символов (осталось ${done.missing.length})`}
            onClick={() => void onExport()}
          >
            {exporting ? 'Собираю…' : 'Экспорт ZIP'}
          </button>
        </div>
      </header>

      <div className="progress-bar slim">
        <div style={{ width: `${done.total ? (done.filled / done.total) * 100 : 0}%` }} />
      </div>

      <main className="workspace">
        <p className="screen-info">
          {firstSlot && lastSlot
            ? `Экран: «${firstSlot.char}» (вар. ${firstSlot.variant}) — «${lastSlot.char}» (вар. ${lastSlot.variant}) · ${firstSlot.groupTitle} · слоты ${cursor + 1}–${cursor + slots.length} из ${queue.length}`
            : 'Очередь пуста'}
        </p>
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${state.settings.cols}, ${displayPx}px)` }}
        >
          {slots.map((slot) => {
            const glyph = state.glyphs[slotId(slot.char, slot.variant)] ?? null;
            return (
              <div key={slot.index} className={glyph ? 'cell filled' : 'cell'}>
                <div className="cell-head">
                  <span className="cell-label">
                    <b>{slot.char}</b> · вар. {slot.variant}
                  </span>
                  <span className="cell-buttons">
                    {glyph && (
                      <button title="Точки входа/выхода" onClick={() => setEditorSlot(slot)}>
                        ✎
                      </button>
                    )}
                    {glyph && (
                      <button title="Очистить клетку" onClick={() => onClear(slot)}>
                        ✕
                      </button>
                    )}
                  </span>
                </div>
                <CellCanvas
                  char={slot.char}
                  glyph={glyph}
                  displayPx={displayPx}
                  fieldCells={state.settings.fieldCells}
                  strokeWidth={state.settings.strokeWidth}
                  showGuides={state.settings.showGuides}
                  onStroke={(g) => onStroke(slot, g)}
                  onTooShort={() => setStatus('Слишком короткий штрих — нарисуйте букву одним движением')}
                />
              </div>
            );
          })}
        </div>
      </main>

      <footer className="bottombar">
        <button disabled={cursor === 0} onClick={onBack}>
          ← Назад
        </button>
        <button onClick={onClearScreen}>Очистить экран</button>
        <button className="primary big" onClick={onNext}>
          {isLastScreen ? 'Сохранить' : 'Следующий →'}
        </button>
        <span className="status">{status}</span>
      </footer>

      {view === 'settings' && (
        <SettingsPanel settings={state.settings} onChange={onSettings} onResetAll={onResetAll} onClose={() => setView('write')} />
      )}
      {view === 'progress' && (
        <ProgressPanel
          queue={queue}
          glyphs={state.glyphs}
          completeness={done}
          variants={state.settings.variants}
          onJump={onJump}
          onClose={() => setView('write')}
        />
      )}
      {editorSlot && editorGlyph && (
        <AnchorEditor
          glyph={editorGlyph}
          displayPx={Math.min(Math.max(displayPx, 260), 420)}
          fieldCells={state.settings.fieldCells}
          strokeWidth={state.settings.strokeWidth}
          showGuides={state.settings.showGuides}
          onSave={(anchors) => {
            const s = stateRef.current;
            const glyph = { ...editorGlyph, anchors };
            void saveStateNow({ ...s, glyphs: { ...s.glyphs, [slotId(editorSlot.char, editorSlot.variant)]: glyph } });
            commit({ ...s, glyphs: { ...s.glyphs, [slotId(editorSlot.char, editorSlot.variant)]: glyph } });
            setEditorSlot(null);
            setStatus('Точки входа/выхода сохранены ✓');
          }}
          onClose={() => setEditorSlot(null)}
        />
      )}
    </div>
  );
}
