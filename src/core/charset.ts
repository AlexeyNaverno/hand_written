/**
 * What the program knows about characters before it has seen the writer's own letters:
 * rough shape expectations (used to align recognised text with the image) and how letters join.
 */

export type Script = 'cyr' | 'lat' | 'digit' | 'punct';
export type JoinLevel = 'low' | 'mid' | 'high';

export interface CharPrior {
  /** Expected width in x-heights. */
  width: number;
  /** Rises clearly above the top of lowercase letters. */
  asc: boolean;
  /** Goes clearly below the baseline. */
  desc: boolean;
  /** Tiny mark (dot, comma, dash). */
  small: boolean;
  /** Vertical place of a small mark: 0 = on the baseline, 0.5 = middle, 1 = top of lowercase letters. */
  level: number;
  /** Most pieces a single letter may be split into by the over-segmentation. */
  maxParts: number;
}

const P = (width: number, asc = false, desc = false, maxParts = 3, small = false, level = 0.5): CharPrior => ({ width, asc, desc, small, level, maxParts });

const table: Record<string, CharPrior> = {};
const put = (chars: string, p: CharPrior) => { for (const c of chars) table[c] = p; };

// Russian cursive, lowercase
put('аеёоэсья', P(0.85, false, false, 3));
put('гзкчх', P(0.8, false, false, 3));
put('илнпцъ', P(1.0, false, false, 4));
put('й', P(1.0, true, false, 4));
put('ё', P(0.85, true, false, 3));
put('бв', P(0.85, true, false, 3));
put('дуз', P(0.95, false, true, 4));
put('р', P(0.9, false, true, 4));
put('ф', P(1.1, true, true, 5));
put('щ', P(1.6, false, true, 6));
put('ц', P(1.05, false, true, 4));
put('тмшжюы', P(1.5, false, false, 6));
// Russian cursive, uppercase
put('АБВГДЕЁЗИЙКЛНОПРСТУХЦЧЭЯЬЪ', P(1.5, true, false, 6));
put('ЖМШЩЮЫФ', P(2.1, true, false, 8));
put('ДУЦЩЗ', { ...P(1.6, true, false, 6) });
// Latin print letters
put('aceonsuvxz', P(0.75, false, false, 3));
put('mw', P(1.25, false, false, 5));
put('r', P(0.55, false, false, 2));
put('bdhk', P(0.75, true, false, 3));
put('filt', P(0.45, true, false, 3));
put('gpqy', P(0.75, false, true, 3));
put('j', P(0.45, true, true, 3));
put('ABCDEFGHIJKLNOPQRSTUVXYZ', P(1.1, true, false, 5));
put('MW', P(1.6, true, false, 6));
// digits
put('0234567890', P(0.8, true, false, 3));
put('1', P(0.5, true, false, 2));
// punctuation and basic maths
put('.', P(0.14, false, false, 1, true, 0));
put(',', P(0.2, false, true, 1, true, -0.1));
put(':', P(0.16, false, false, 2, true, 0.4));
put(';', P(0.22, false, true, 2, true, 0.3));
put('!', P(0.25, true, false, 2));
put('?', P(0.7, true, false, 3));
put('-', P(0.5, false, false, 2, true, 0.5));
put('–—', P(1.0, false, false, 3, true, 0.5));
put('=', P(0.65, false, false, 3, true, 0.5));
put('+', P(0.7, false, false, 3, true, 0.5));
put('*×·', P(0.4, false, false, 2, true, 0.6));
put('/\\', P(0.6, true, false, 2));
put('()[]{}', P(0.4, true, true, 2));
put('"«»“”„', P(0.5, true, false, 3, true, 1.2));
put("'’`", P(0.2, true, false, 1, true, 1.3));
put('%', P(1.1, true, false, 5));
put('№', P(1.6, true, false, 6));
put('<>', P(0.7, false, false, 2));
put('^', P(0.5, true, false, 2, true, 1.3));
put('~', P(0.7, false, false, 2, true, 0.5));
put('…', P(0.7, false, false, 3, true, 0));
put('_', P(0.8, false, true, 2, true, -0.1));

const fallback = P(0.9, false, false, 4);

export function charPrior(ch: string): CharPrior {
  return table[ch] ?? fallback;
}

export function scriptOf(ch: string): Script {
  if (/[а-яёА-ЯЁ]/.test(ch)) return 'cyr';
  if (/[a-zA-Z]/.test(ch)) return 'lat';
  if (/[0-9]/.test(ch)) return 'digit';
  return 'punct';
}

export const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Russian letters are written joined; English letters are print letters and stand apart, like digits and signs. */
export function isJoining(ch: string): boolean {
  return scriptOf(ch) === 'cyr';
}

/**
 * Where the pen leaves a lowercase cursive letter when the next letter follows:
 * after о, в, ю, ь, ъ, б the connection starts near the top of the letter body, otherwise near the baseline.
 */
export function exitLevel(ch: string): JoinLevel {
  return 'овюьъб'.includes(ch.toLowerCase()) ? 'high' : 'low';
}

/** Where the pen arrives: л, м, я start from the baseline, the others near the top of the letter body. */
export function entryLevel(ch: string): JoinLevel {
  return 'лмя'.includes(ch.toLowerCase()) ? 'low' : 'high';
}

/** Characters the library is expected to cover, in the order shown to the user. */
export const COVERAGE: { title: string; chars: string }[] = [
  { title: 'Строчные', chars: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя' },
  { title: 'Заглавные', chars: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ' },
  { title: 'Цифры', chars: '0123456789' },
  { title: 'Знаки', chars: '.,:;!?-—()«»"\'' },
  { title: 'Математика', chars: '+=×*/<>%№' },
  { title: 'Английские строчные', chars: 'abcdefghijklmnopqrstuvwxyz' },
  { title: 'Английские заглавные', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
];

const PUNCT_NAMES: Record<string, string> = {
  '.': 'точка', ',': 'запятая', ':': 'двоеточие', ';': 'точка_с_запятой', ')': 'правая_скобка', '(': 'левая_скобка',
  '-': 'тире', '—': 'длинное_тире', '–': 'среднее_тире', '!': 'восклицательный', '?': 'вопросительный', '"': 'кавычки',
  '«': 'левая_ёлочка', '»': 'правая_ёлочка', "'": 'апостроф', '+': 'плюс', '=': 'равно', '*': 'звёздочка', '×': 'умножить',
  '/': 'дробь', '\\': 'обратная_дробь', '<': 'меньше', '>': 'больше', '%': 'процент', '№': 'номер', '[': 'левая_квадратная',
  ']': 'правая_квадратная', '{': 'левая_фигурная', '}': 'правая_фигурная', '…': 'многоточие', '_': 'подчёркивание',
  '~': 'тильда', '^': 'крышка', '·': 'точка_по_центру',
};
const NAME_TO_PUNCT: Record<string, string> = Object.fromEntries(Object.entries(PUNCT_NAMES).map(([k, v]) => [v, k]));

/**
 * File name stem for a glyph, compatible with the old desktop program:
 * lowercase letters as is, "загл_" prefix for capitals, Russian names for signs, digits doubled with the variant.
 */
export function fileStem(ch: string, variant: number): string {
  if (/[0-9]/.test(ch)) return `${ch}${variant}`;
  if (PUNCT_NAMES[ch]) return `${PUNCT_NAMES[ch]}_${variant}`;
  const sc = scriptOf(ch);
  if (sc === 'lat') return `${isUpper(ch) ? 'lat_upper_' : 'lat_'}${ch.toLowerCase()}_${variant}`;
  if (isUpper(ch)) return `загл_${ch.toLowerCase()}_${variant}`;
  return `${ch}_${variant}`;
}

/** Inverse of fileStem, also accepting the old program's names ("а3", "загл_б2", "точка", "01"). */
export function parseStem(stem: string): { char: string; variant: number } | null {
  let name = stem.normalize('NFC');
  if (/^[0-9]+$/.test(name)) return { char: name[0], variant: name.length > 1 ? parseInt(name.slice(1), 10) : 1 };
  let variant = 1;
  const m = name.match(/^(.*?)[_]?(\d+)$/);
  if (m && m[1].length) { name = m[1]; variant = parseInt(m[2], 10); }
  if (NAME_TO_PUNCT[name]) return { char: NAME_TO_PUNCT[name], variant };
  let upper = false;
  if (name.startsWith('загл_')) { upper = true; name = name.slice(5); }
  if (name.startsWith('lat_upper_')) return { char: name.slice(10).toUpperCase(), variant };
  if (name.startsWith('lat_')) return { char: name.slice(4), variant };
  if ([...name].length === 1) return { char: upper ? name.toUpperCase() : name, variant };
  return null;
}
