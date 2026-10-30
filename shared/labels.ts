/**
 * Надписи, которые администратор меняет в админ-панели (вкладка «Надписи»).
 *
 * Все тексты лежат в объектах `t` (client/src/strings.ts) и `txt` (server/src/strings.ts).
 * Каждая надпись получает ключ — путь в объекте через точку: `settings.aboutText`,
 * `games.list.snake.0`. Серверные ключи начинаются с `server.`.
 *
 * Строки-функции (`(n) => \`${n} участников\``) редактируются как шаблон: `{1}`, `{2}` —
 * это первое, второе подставляемое значение. Заменённая функция теряет склонение по числу.
 */

/** Одна надпись: ключ и текст по умолчанию (для функций — с `{1}`, `{2}` вместо значений) */
export interface LabelDefault {
  key: string;
  text: string;
  /** сколько значений подставляется; 0 — обычная строка */
  args: number;
}

/** Замены надписей: ключ → новый текст */
export type LabelOverrides = Record<string, string>;

export interface LabelsDTO {
  /** меняется при каждом сохранении */
  version: number;
  labels: LabelOverrides;
}

export const LABEL_MAX = 4000;
export const SERVER_LABEL_PREFIX = 'server.';

type Tree = Record<string, unknown>;

/** Ключи, которые не надписи: язык дат и списки служебных идентификаторов */
const SKIP = new Set(['locale', 'rightsFor']);

const marker = (i: number) => `{${i + 1}}`;

/** Подставляет значения в шаблон: `{1}` — первое, `{2}` — второе */
export function fillLabel(template: string, args: unknown[]) {
  return template.replace(/\{(\d+)\}/g, (m, i: string) => {
    const v = args[Number(i) - 1];
    return v === undefined || v === null ? m : String(v);
  });
}

interface Slot {
  parent: Tree | unknown[];
  prop: string | number;
  original: unknown;
  args: number;
}

/**
 * Запоминает исходные значения всех надписей объекта, чтобы потом менять их на месте
 * и возвращать обратно. Вызывайте до первого применения замен.
 */
export function labelRegistry(root: Tree, prefix = '') {
  const slots = new Map<string, Slot>();
  const defaults: LabelDefault[] = [];

  const walk = (node: Tree | unknown[], path: string) => {
    const entries: [string | number, unknown][] = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
    for (const [prop, value] of entries) {
      if (typeof prop === 'string' && SKIP.has(prop)) continue;
      const key = `${path}${String(prop)}`;
      if (typeof value === 'string') {
        slots.set(key, { parent: node, prop, original: value, args: 0 });
        defaults.push({ key, text: value, args: 0 });
      } else if (typeof value === 'function') {
        const fn = value as (...a: unknown[]) => unknown;
        const n = fn.length;
        let sample: unknown;
        try {
          sample = fn(...Array.from({ length: n }, (_, i) => marker(i)));
        } catch {
          continue;
        }
        if (typeof sample !== 'string') continue;
        slots.set(key, { parent: node, prop, original: value, args: n });
        defaults.push({ key, text: sample, args: n });
      } else if (value && typeof value === 'object') {
        walk(value as Tree, `${key}.`);
      }
    }
  };
  walk(root, prefix);

  return {
    defaults,
    has: (key: string) => slots.has(key),
    /** Ставит замены на место исходных текстов; надписи без замены возвращаются к исходным. */
    apply(overrides: LabelOverrides) {
      for (const [key, slot] of slots) {
        const o = overrides[key];
        let next = slot.original;
        if (typeof o === 'string') {
          next = slot.args || typeof slot.original === 'function' ? (...a: unknown[]) => fillLabel(o, a) : o;
        }
        (slot.parent as Record<string | number, unknown>)[slot.prop] = next;
      }
    },
  };
}
