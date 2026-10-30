import { FORMAT_RE, HASHTAG_RE, unquote } from '@timba/shared';

/**
 * Text between bots and the messenger.
 *
 * The messenger's own markup is `**bold**`, `__italic__`, `~~strike~~`, `` `code` ``, ```` ```pre``` ````, `||spoiler||`,
 * `[text](url)` and `> quote` (shared/src/text.ts). Bots speak Telegram: they send HTML or Markdown with `parse_mode`
 * or a list of `entities`, and receive plain text with `entities`. These functions convert in both directions.
 * Offsets and lengths are counted in UTF-16 code units, like Telegram does (and like JavaScript strings).
 */

export interface ApiEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

// ---------- the messenger's markup -> plain text + entities (what a bot receives) ----------

const COMMAND_RE = /(?<![^\s])\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z][A-Za-z0-9_]{2,31})?(?![A-Za-z0-9_@])/g;
const MENTION_RE = /(?<![A-Za-z0-9_])@[A-Za-z][A-Za-z0-9_]{2,31}/g;
const URL_RE = /https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g;

export function nativeToEntities(src: string): { text: string; entities: ApiEntity[] } {
  const entities: ApiEntity[] = [];
  let out = '';
  const walk = (s: string) => {
    let last = 0;
    for (const m of s.matchAll(FORMAT_RE)) {
      out += s.slice(last, m.index);
      last = m.index! + m[0].length;
      const [whole, pre, code, bold, italic, strike, spoiler, linkLabel, linkUrl, quote] = m;
      const start = out.length;
      const add = (e: Omit<ApiEntity, 'offset' | 'length'>) => entities.push({ ...e, offset: start, length: out.length - start });
      if (pre !== undefined) {
        out += pre.replace(/^\n/, '');
        add({ type: 'pre' });
      } else if (code !== undefined) {
        out += code;
        add({ type: 'code' });
      } else if (bold !== undefined) {
        walk(bold);
        add({ type: 'bold' });
      } else if (italic !== undefined) {
        walk(italic);
        add({ type: 'italic' });
      } else if (strike !== undefined) {
        walk(strike);
        add({ type: 'strikethrough' });
      } else if (spoiler !== undefined) {
        walk(spoiler);
        add({ type: 'spoiler' });
      } else if (linkLabel !== undefined) {
        walk(linkLabel);
        add({ type: 'text_link', url: linkUrl });
      } else if (quote !== undefined) {
        walk(unquote(quote));
        add({ type: 'blockquote' });
        // the line break that ended the quote stays
        if (whole.endsWith('\n')) out += '\n';
      }
    }
    out += s.slice(last);
  };
  walk(src);

  // what the text itself shows: commands, @mentions, addresses and #hashtags (not inside code or links)
  const covered = (a: number, b: number) =>
    entities.some((e) => (e.type === 'code' || e.type === 'pre' || e.type === 'text_link') && a < e.offset + e.length && b > e.offset);
  const scan = (re: RegExp, type: string) => {
    for (const m of out.matchAll(re)) {
      const offset = m.index!;
      if (!covered(offset, offset + m[0].length)) entities.push({ type, offset, length: m[0].length });
    }
  };
  scan(COMMAND_RE, 'bot_command');
  scan(MENTION_RE, 'mention');
  scan(URL_RE, 'url');
  scan(HASHTAG_RE, 'hashtag');
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: out, entities };
}

// ---------- entities -> the messenger's markup (a bot sent text and entities) ----------

const MARKS: Record<string, [string, string]> = {
  bold: ['**', '**'],
  italic: ['__', '__'],
  strikethrough: ['~~', '~~'],
  spoiler: ['||', '||'],
  code: ['`', '`'],
  pre: ['```\n', '\n```'],
};

export function entitiesToNative(text: string, entities: ApiEntity[]): string {
  type Event = { pos: number; open: boolean; idx: number; len: number; str: string };
  const events: Event[] = [];
  entities.forEach((e, idx) => {
    const a = Math.max(0, e.offset);
    const b = Math.min(text.length, e.offset + e.length);
    if (b <= a) return;
    const len = b - a;
    if (MARKS[e.type]) {
      events.push({ pos: a, open: true, idx, len, str: MARKS[e.type]![0] }, { pos: b, open: false, idx, len, str: MARKS[e.type]![1] });
    } else if (e.type === 'text_link' && e.url) {
      events.push({ pos: a, open: true, idx, len, str: '[' }, { pos: b, open: false, idx, len, str: `](${e.url})` });
    } else if (e.type === 'blockquote' || e.type === 'expandable_blockquote') {
      // every line of the quote starts with "> "
      events.push({ pos: a, open: true, idx, len, str: '> ' });
      for (let i = a; i < b - 1; i++) if (text[i] === '\n') events.push({ pos: i + 1, open: true, idx, len: 0, str: '> ' });
    }
  });
  // at one position what ends comes before what starts; the outer one starts first and ends last
  events.sort((x, y) => x.pos - y.pos || Number(x.open) - Number(y.open) || (x.open ? y.len - x.len || x.idx - y.idx : y.idx - x.idx));
  let out = '';
  let last = 0;
  for (const ev of events) {
    out += text.slice(last, ev.pos) + ev.str;
    last = ev.pos;
  }
  return out + text.slice(last);
}

// ---------- HTML -> the messenger's markup ----------

const HTML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(e: string): string {
  if (e in HTML_ENTITIES) return HTML_ENTITIES[e]!;
  const code = e.startsWith('#x') || e.startsWith('#X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : `&${e};`;
}

export function htmlToNative(html: string): string {
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>|&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g;
  let out = '';
  let last = 0;
  const stack: { tag: string; start: number; close: string }[] = [];
  let inPre = 0;
  const quoteFrom = (start: number) => {
    const body = out.slice(start).replace(/^\n+|\n+$/g, '');
    const quoted = body
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    out = `${out.slice(0, start)}${start && !out.slice(0, start).endsWith('\n') ? '\n' : ''}${quoted}\n`;
  };
  for (const m of html.matchAll(TAG)) {
    out += html.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[4]) {
      out += decodeEntity(m[4]);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';
    if (closing) {
      // close the nearest open tag of this name (and whatever was left open inside it)
      let i = stack.length - 1;
      while (i >= 0 && stack[i]!.tag !== tag) i--;
      if (i < 0) continue;
      for (let j = stack.length - 1; j >= i; j--) {
        const t = stack[j]!;
        if (t.tag === 'blockquote') quoteFrom(t.start);
        else out += t.close;
        if (t.tag === 'pre') inPre--;
      }
      stack.length = i;
      continue;
    }
    let open = '';
    let close = '';
    switch (tag) {
      case 'b':
      case 'strong':
        [open, close] = ['**', '**'];
        break;
      case 'i':
      case 'em':
        [open, close] = ['__', '__'];
        break;
      case 's':
      case 'strike':
      case 'del':
        [open, close] = ['~~', '~~'];
        break;
      case 'tg-spoiler':
        [open, close] = ['||', '||'];
        break;
      case 'span':
        if (/class\s*=\s*["']tg-spoiler["']/.test(attrs)) [open, close] = ['||', '||'];
        break;
      case 'code':
        // <pre><code> is one block of code
        if (!inPre) [open, close] = ['`', '`'];
        break;
      case 'pre':
        [open, close] = ['```\n', '\n```'];
        inPre++;
        break;
      case 'a': {
        const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
        const url = (href?.[1] ?? href?.[2] ?? '').replace(/&amp;/g, '&');
        if (/^https?:\/\//i.test(url)) [open, close] = ['[', `](${url})`];
        break;
      }
      case 'blockquote':
        break;
      default:
        // u, ins and unknown tags: the text stays, the tag goes
        break;
    }
    out += open;
    stack.push({ tag, start: out.length, close });
  }
  out += html.slice(last);
  // tags left open are closed at the end
  for (let j = stack.length - 1; j >= 0; j--) {
    const t = stack[j]!;
    if (t.tag === 'blockquote') quoteFrom(t.start);
    else out += t.close;
  }
  return out;
}

// ---------- Telegram's Markdown / MarkdownV2 -> the messenger's markup ----------

export function markdownToNative(src: string, v2: boolean): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    // a backslash makes the next character an ordinary one
    if (c === '\\' && i + 1 < n && /[_*[\]()~`>#+\-=|{}.!\\]/.test(src[i + 1]!)) {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (src.startsWith('```', i)) {
      const end = src.indexOf('```', i + 3);
      if (end > 0) {
        let body = src.slice(i + 3, end);
        // a language name on the first line is not part of the code
        body = body.replace(/^[A-Za-z0-9_+-]*\n/, '');
        out += `\`\`\`\n${body.replace(/\n$/, '')}\n\`\`\``;
        i = end + 3;
        continue;
      }
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > 0) {
        out += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (c === '*') {
      out += '**';
      i++;
      continue;
    }
    if (c === '_') {
      if (v2 && src[i + 1] === '_') {
        // MarkdownV2 underline has no counterpart here: the text stays plain
        i += 2;
        continue;
      }
      out += '__';
      i++;
      continue;
    }
    if (v2 && c === '~') {
      out += '~~';
      i++;
      continue;
    }
    if (v2 && c === '|' && src[i + 1] === '|') {
      out += '||';
      i += 2;
      continue;
    }
    if (v2 && c === '>' && (i === 0 || src[i - 1] === '\n')) {
      out += '> ';
      i++;
      if (src[i] === ' ') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The text of a send/edit call in the messenger's markup, whatever way the bot wrote it. */
export function toNative(text: string, parseMode: string | undefined, entities: ApiEntity[] | undefined): string {
  if (entities?.length) return entitiesToNative(text, entities);
  switch ((parseMode ?? '').toLowerCase()) {
    case 'html':
      return htmlToNative(text);
    case 'markdown':
      return markdownToNative(text, false);
    case 'markdownv2':
      return markdownToNative(text, true);
    default:
      return text;
  }
}
