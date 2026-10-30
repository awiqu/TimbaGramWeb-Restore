/**
 * Награды администрации: восемь степеней, от 8-й (самой простой) до 1-й (самой лучшей).
 * Картинки степеней рисует клиент (components/Awards.tsx) по `colors` и `glyph`.
 */

export const AWARD_DEGREE_MIN = 1;
export const AWARD_DEGREE_MAX = 8;

/** Какой рисунок стоит в центре медали */
export type AwardGlyph = 'crown' | 'star' | 'gem' | 'shield' | 'bolt' | 'heart' | 'flower' | 'dot';

export interface AwardDegree {
  /** 1 — лучшая, 8 — самая простая */
  degree: number;
  name: string;
  /** светлый и тёмный цвет медали */
  colors: [string, string];
  /** цвет ленты */
  ribbon: [string, string];
  glyph: AwardGlyph;
}

/** От лучшей степени к простой: AWARD_DEGREES[0] — 1-я степень */
export const AWARD_DEGREES: readonly AwardDegree[] = [
  { degree: 1, name: 'Легенда TimbaGram', colors: ['#fff1a8', '#f0a000'], ribbon: ['#7b5cff', '#e056fd'], glyph: 'crown' },
  { degree: 2, name: 'Золотая звезда', colors: ['#ffe27a', '#d99100'], ribbon: ['#ff6b6b', '#c0262d'], glyph: 'star' },
  { degree: 3, name: 'Платиновый орден', colors: ['#f4f9ff', '#8fa8c8'], ribbon: ['#4a7fb5', '#2c4f7c'], glyph: 'gem' },
  { degree: 4, name: 'Серебряный щит', colors: ['#f6f6f9', '#9a9ea8'], ribbon: ['#6b7280', '#3f4551'], glyph: 'shield' },
  { degree: 5, name: 'Бронзовая молния', colors: ['#f0b27a', '#9b5a2a'], ribbon: ['#c0702f', '#7a3e12'], glyph: 'bolt' },
  { degree: 6, name: 'Медаль героя', colors: ['#ff9a9a', '#c0262d'], ribbon: ['#ffd95a', '#d99100'], glyph: 'heart' },
  { degree: 7, name: 'Знак активиста', colors: ['#9be5ae', '#2f9e55'], ribbon: ['#2f9e55', '#1b6b38'], glyph: 'flower' },
  { degree: 8, name: 'Значок участника', colors: ['#b9dcff', '#4a7fb5'], ribbon: ['#9fb4c9', '#5b738c'], glyph: 'dot' },
];

/** The degree (1…8); anything else falls back to the simplest one. */
export function awardDegree(degree: number): AwardDegree {
  return AWARD_DEGREES.find((d) => d.degree === degree) ?? AWARD_DEGREES[AWARD_DEGREES.length - 1]!;
}

export const AWARD_CAPTION_MAX = 120;
/** how many awards one profile can hold */
export const AWARDS_MAX = 30;

/** Подписи под ником в профиле («Скам» красным, «Создатель TimbaGram» зелёным) */
export const TAG_TEXT_MAX = 40;
export const TAGS_MAX = 5;
export const TAG_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Цвета, которые админ выбирает одним нажатием; любой другой — через палитру */
export const TAG_COLORS: readonly { name: string; color: string }[] = [
  { name: 'Красный', color: '#e5383b' },
  { name: 'Оранжевый', color: '#f77f00' },
  { name: 'Жёлтый', color: '#d9a400' },
  { name: 'Зелёный', color: '#2f9e55' },
  { name: 'Голубой', color: '#0ea5c6' },
  { name: 'Синий', color: '#2f6fed' },
  { name: 'Фиолетовый', color: '#8e44ad' },
  { name: 'Розовый', color: '#e0457b' },
  { name: 'Серый', color: '#7b8794' },
];

/** Значок у имени: картинка размером с букву */
export const BADGE_TITLE_MAX = 40;
/** the stored picture is a square PNG this big (it is shown about 1em high) */
export const BADGE_IMAGE_SIZE = 96;
