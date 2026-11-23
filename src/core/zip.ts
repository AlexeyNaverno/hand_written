/**
 * Сборка итогового ZIP: папка symbols/ с JSON в формате HTML-редактора
 * (по одному файлу на вариант, имя — fileStem) + manifest.json + README.txt.
 * Экспорт доступен только когда заполнены все слоты очереди.
 */
import { zipSync } from 'fflate';
import { fileStem, GROUPS } from './charset';
import type { GlyphData, Slot } from './glyph';
import { slotId } from './glyph';

export interface Completeness {
  total: number;
  filled: number;
  missing: Slot[];
  complete: boolean;
}

export function completeness(queue: Slot[], glyphs: Record<string, GlyphData>): Completeness {
  const missing = queue.filter((s) => !glyphs[slotId(s.char, s.variant)]);
  return { total: queue.length, filled: queue.length - missing.length, missing, complete: missing.length === 0 };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const enc = new TextEncoder();

export function buildZipEntries(queue: Slot[], glyphs: Record<string, GlyphData>): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const symbols = queue.map((s) => {
    const glyph = glyphs[slotId(s.char, s.variant)]!;
    const file = `${fileStem(s.char, s.variant)}.json`;
    entries.push({ name: `symbols/${file}`, data: enc.encode(JSON.stringify(glyph, null, 2)) });
    return { file, char: s.char, variant: s.variant, group: s.groupTitle };
  });

  const manifest = {
    schema: 1,
    app: 'Почерк — буквы (hand-written)',
    exportedAt: new Date().toISOString(),
    canvas: { width: 600, height: 600 },
    variantsPerChar: queue.length ? Math.max(...queue.map((s) => s.variant)) : 0,
    groups: GROUPS.map((g) => ({ id: g.id, title: g.title, chars: g.chars })),
    symbols,
  };
  entries.push({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });

  const readme = [
    'Рукописные глифы, собранные в приложении «Почерк — буквы».',
    '',
    'Папка symbols/: по одному JSON на вариант каждого символа.',
    'Формат JSON — как в Cursive Glyph Editor: { char, metrics, path, anchors }.',
    'Имя файла стандартизировано и легко парсится:',
    '  а_1.json            русские строчные',
    '  загл_а_1.json       русские заглавные',
    '  lat_a_1.json        английские строчные',
    '  lat_upper_a_1.json  английские заглавные',
    '  digit_5_1.json      цифры',
    '  точка_1.json        знаки препинания и математика (имя знака + вариант)',
    'Номер после последнего подчёркивания — вариант (1, 2, 3, 4, ...).',
    'manifest.json содержит полный список файлов с символами и вариантами.',
    '',
  ].join('\n');
  entries.push({ name: 'README.txt', data: enc.encode(readme) });
  return entries;
}

export function buildZip(queue: Slot[], glyphs: Record<string, GlyphData>): Uint8Array {
  const obj: Record<string, Uint8Array> = {};
  for (const e of buildZipEntries(queue, glyphs)) obj[e.name] = e.data;
  return zipSync(obj, { level: 6 });
}
