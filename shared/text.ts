/**
 * Message formatting, Telegram style:
 * **жирный**  __курсив__  ~~зачёркнутый~~  `код`  ```блок кода```  ||спойлер||
 * [текст ссылки](https://адрес)  и цитата — строки, начинающиеся с «> ».
 *
 * New kinds are appended to the regex: code that reads the groups by position keeps working.
 */
export const FORMAT_RE =
  /```([\s\S]+?)```|`([^`\n]+)`|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\|\|([\s\S]+?)\|\||\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|(?<![^\n])(>(?: [^\n]*)?(?![^\n])(?:\n>(?: [^\n]*)?(?![^\n]))*)\n?/g;

/** A quote block without its "> " markers. */
export const unquote = (block: string) => block.replace(/^> ?/gm, '');

/** Text without the markers, spoilers hidden — for chat list previews and notifications. */
export function stripFormatting(text: string): string {
  return text.replace(FORMAT_RE, (whole, pre, code, b, i, s, spoiler, linkLabel, _linkUrl, quote) => {
    if (spoiler !== undefined) return '▒'.repeat(Math.min(Math.max(spoiler.length, 3), 12));
    // the line break that ended the quote stays, so the next line does not stick to it
    if (quote !== undefined) return stripFormatting(unquote(quote)) + (whole.endsWith('\n') ? '\n' : '');
    return pre ?? code ?? linkLabel ?? stripFormatting(b ?? i ?? s ?? '');
  });
}

/** #hashtags: a letter must be in the tag, and "C#" or "page/#part" are not tags. */
export const HASHTAG_RE = /(?<![\p{L}\p{N}_#&/])#(?=[\p{N}_]*\p{L})[\p{L}\p{N}_]{1,64}/gu;

/** Lower-case hashtags of a search query, like ["#новости"]. */
export const queryHashtags = (q: string) => [...new Set(q.toLowerCase().match(HASHTAG_RE) ?? [])];

/**
 * A text longer than one message as several pieces of at most `max` characters, like Telegram sends it:
 * cut at a paragraph, else at a line break, else at a space, and only as a last resort inside a word.
 */
export function splitLongText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    // a cut too close to the start would leave a tiny piece: look for breaks in the second half only
    const from = Math.floor(max / 2);
    let at = window.lastIndexOf('\n\n');
    if (at < from) at = window.lastIndexOf('\n');
    if (at < from) at = window.lastIndexOf(' ');
    if (at < from) at = max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
