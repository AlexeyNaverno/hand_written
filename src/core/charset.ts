/**
 * Символы, которые нужно собрать, и стандартизированные имена файлов для экспорта.
 *
 * Нумерация полностью автоматическая: пользователь никогда не вводит номер
 * символа или варианта — порядок очереди и номер варианта задаёт приложение.
 *
 * Схема имён файлов (легко парсится, безопасна для ZIP и Windows/Android):
 *   русские строчные   а_1.json            (сам символ + "_" + вариант)
 *   русские заглавные  загл_а_1.json
 *   английские строчные lat_a_1.json
 *   английские заглавные lat_upper_a_1.json
 *   цифры              digit_5_1.json
 *   знаки и математика <имя>_1.json        (точка_1.json, запятая_2.json, ...)
 * Вариант — целое число от 1, без ведущих нулей.
 */

export interface SymbolGroup {
  id: string;
  title: string;
  chars: string;
}

export const GROUPS: SymbolGroup[] = [
  { id: 'cyr-lower', title: 'Русские строчные', chars: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя' },
  { id: 'cyr-upper', title: 'Русские заглавные', chars: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' },
  { id: 'lat-lower', title: 'Английские строчные', chars: 'abcdefghijklmnopqrstuvwxyz' },
  { id: 'lat-upper', title: 'Английские заглавные', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { id: 'digits', title: 'Цифры', chars: '0123456789' },
  { id: 'punct', title: 'Знаки препинания', chars: '.,:;!?-—()«»"\'' },
  { id: 'math', title: 'Математика и знаки', chars: '=+×*/<>%№' },
];

/** Все символы в порядке очереди, без повторов. */
export const ALL_CHARS: string[] = [...new Set(GROUPS.flatMap((g) => [...g.chars]))];

export type Script = 'cyr' | 'lat' | 'digit' | 'punct';

export function scriptOf(ch: string): Script {
  if (/[а-яёА-ЯЁ]/.test(ch)) return 'cyr';
  if (/[a-zA-Z]/.test(ch)) return 'lat';
  if (/[0-9]/.test(ch)) return 'digit';
  return 'punct';
}

export const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Русские имена знаков — только ASCII-буквы и подчёркивания, безопасны для имён файлов. */
const PUNCT_NAMES: Record<string, string> = {
  '.': 'точка',
  ',': 'запятая',
  ':': 'двоеточие',
  ';': 'точка_с_запятой',
  '!': 'восклицательный',
  '?': 'вопросительный',
  '-': 'тире',
  '—': 'длинное_тире',
  '(': 'левая_скобка',
  ')': 'правая_скобка',
  '«': 'левая_ёлочка',
  '»': 'правая_ёлочка',
  '"': 'кавычки',
  "'": 'апостроф',
  '=': 'равно',
  '+': 'плюс',
  '×': 'умножить',
  '*': 'звёздочка',
  '/': 'дробь',
  '<': 'меньше',
  '>': 'больше',
  '%': 'процент',
  '№': 'номер',
};

const NAME_TO_PUNCT: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCT_NAMES).map(([k, v]) => [v, k]),
);

/** Стандартизированное имя файла (без расширения) для символа и варианта. */
export function fileStem(ch: string, variant: number): string {
  const sc = scriptOf(ch);
  if (sc === 'digit') return `digit_${ch}_${variant}`;
  if (PUNCT_NAMES[ch]) return `${PUNCT_NAMES[ch]}_${variant}`;
  if (sc === 'lat') return `${isUpper(ch) ? 'lat_upper_' : 'lat_'}${ch.toLowerCase()}_${variant}`;
  if (isUpper(ch)) return `загл_${ch.toLowerCase()}_${variant}`;
  return `${ch}_${variant}`;
}

/** Обратное преобразование fileStem: имя файла -> символ и вариант. */
export function parseStem(stem: string): { char: string; variant: number } | null {
  const name = stem.normalize('NFC').replace(/\.json$/i, '');
  let m: RegExpMatchArray | null;
  if ((m = name.match(/^digit_([0-9])_(\d+)$/))) return { char: m[1], variant: parseInt(m[2], 10) };
  if ((m = name.match(/^lat_upper_([a-z])_(\d+)$/))) return { char: m[1].toUpperCase(), variant: parseInt(m[2], 10) };
  if ((m = name.match(/^lat_([a-z])_(\d+)$/))) return { char: m[1], variant: parseInt(m[2], 10) };
  if ((m = name.match(/^загл_(.)_(\d+)$/u))) return { char: m[1].toUpperCase(), variant: parseInt(m[2], 10) };
  if ((m = name.match(/^(.+)_(\d+)$/))) {
    const base = m[1];
    const variant = parseInt(m[2], 10);
    if (NAME_TO_PUNCT[base]) return { char: NAME_TO_PUNCT[base], variant };
    if ([...base].length === 1) return { char: base, variant };
  }
  return null;
}
