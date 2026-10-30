import { FORMAT_RE, isQuietNow, minutesToTime, splitLongText, stripFormatting, timeToMinutes, unquote } from '@timba/shared';
import { describe, expect, it } from 'vitest';

describe('message formatting', () => {
  it('strips the old markers as before', () => {
    expect(stripFormatting('**жирный** __курсив__ ~~зачёрк~~ `код`')).toBe('жирный курсив зачёрк код');
    expect(stripFormatting('||секрет||')).toBe('▒▒▒▒▒▒');
    expect(stripFormatting('```\nconst a = 1;\n```')).toBe('\nconst a = 1;\n');
  });

  it('turns [text](url) into its text', () => {
    expect(stripFormatting('смотри [наш сайт](https://example.com/a?b=1) сегодня')).toBe('смотри наш сайт сегодня');
    // a bracket pair with a parenthesised address (wikipedia style)
    expect(stripFormatting('[Тест](https://ru.wikipedia.org/wiki/Тест_(значения))')).toBe('Тест');
  });

  it('leaves alone what is not a link', () => {
    for (const s of ['[a](javascript:alert(1))', '[a](/relative)', '[a] (https://x.y)', '[](https://x.y)', 'массив[0](1)']) {
      expect(stripFormatting(s)).toBe(s);
    }
  });

  it('quotes consecutive lines that start with "> "', () => {
    expect(stripFormatting('> первая\n> вторая\nобычная')).toBe('первая\nвторая\nобычная');
    expect(stripFormatting('вступление\n> цитата')).toBe('вступление\nцитата');
    expect(stripFormatting('> **жирная** цитата')).toBe('жирная цитата');
    expect(unquote('> a\n>\n> b')).toBe('a\n\nb');
  });

  it('does not take ordinary ">" for a quote', () => {
    for (const s of ['5 > 3', 'a>b', '>5 минут', '-> дальше', 'строка\nтекст > ещё']) {
      expect(stripFormatting(s)).toBe(s);
    }
  });

  it('a quote marker inside a code block stays code', () => {
    expect(stripFormatting('```\n> not a quote\n```')).toBe('\n> not a quote\n');
  });

  it('exposes the groups in a stable order for the renderer', () => {
    const m = [...'[t](https://a.b)'.matchAll(FORMAT_RE)][0]!;
    expect(m[7]).toBe('t');
    expect(m[8]).toBe('https://a.b');
    const q = [...'> x'.matchAll(FORMAT_RE)][0]!;
    expect(q[9]).toBe('> x');
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    stripFormatting('['.repeat(20000));
    stripFormatting('[a'.repeat(20000));
    stripFormatting('>\n'.repeat(20000));
    stripFormatting('> a\n'.repeat(5000) + 'x'.repeat(20000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('long texts', () => {
  it('splits a long text at paragraphs, lines, spaces, and words only when it must', () => {
    expect(splitLongText('коротко', 10)).toEqual(['коротко']);
    const para = `${'а'.repeat(60)}\n\n${'б'.repeat(60)}`;
    expect(splitLongText(para, 100)).toEqual(['а'.repeat(60), 'б'.repeat(60)]);
    const words = Array.from({ length: 30 }, (_, i) => `слово${i}`).join(' ');
    const parts = splitLongText(words, 50);
    expect(parts.every((p) => p.length <= 50)).toBe(true);
    expect(parts.join(' ')).toBe(words);
    expect(splitLongText('я'.repeat(25), 10)).toEqual(['я'.repeat(10), 'я'.repeat(10), 'я'.repeat(5)]);
  });
});

describe('quiet hours', () => {
  // the device is at UTC+3 (getTimezoneOffset() = -180); 22:00 → 08:00 goes over midnight
  const q = { on: true, from: 22 * 60, to: 8 * 60, tz: -180 };
  const at = (h: number, m = 0) => Date.UTC(2026, 0, 10, h - 3, m);

  it('covers an interval over midnight in the local time', () => {
    expect(isQuietNow(q, at(23))).toBe(true);
    expect(isQuietNow(q, at(3))).toBe(true);
    expect(isQuietNow(q, at(7, 59))).toBe(true);
    expect(isQuietNow(q, at(8))).toBe(false);
    expect(isQuietNow(q, at(15))).toBe(false);
    expect(isQuietNow(q, at(22))).toBe(true);
  });

  it('handles a daytime interval, an empty one and the switch', () => {
    const day = { on: true, from: 13 * 60, to: 15 * 60, tz: 0 };
    expect(isQuietNow(day, Date.UTC(2026, 0, 10, 14))).toBe(true);
    expect(isQuietNow(day, Date.UTC(2026, 0, 10, 15))).toBe(false);
    expect(isQuietNow({ ...q, from: 60, to: 60 }, at(1))).toBe(false);
    expect(isQuietNow({ ...q, on: false }, at(23))).toBe(false);
    expect(isQuietNow(undefined)).toBe(false);
  });

  it('reads and writes the time as HH:MM', () => {
    expect(minutesToTime(1350)).toBe('22:30');
    expect(timeToMinutes('07:05')).toBe(425);
    expect(timeToMinutes('24:00')).toBeNull();
    expect(timeToMinutes('abc')).toBeNull();
  });
});

describe('vCard import', () => {
  it('takes the numbers of every card and nothing else, in any spelling', async () => {
    const { parseVcard } = await import('@timba/shared');
    const file = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Иванов;Пётр;;;',
      'FN:Пётр Иванов',
      'TEL;type=CELL;type=VOICE;type=pref:+7 921 123-45-67',
      'item1.TEL;type=pref:8 (911) 765-43-21',
      'EMAIL:petr@example.com',
      'TEL;TYPE=WORK:+7 921 123-45-67',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Без номера',
      'EMAIL:nobody@example.com',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:Длинная строка',
      'TEL;TYPE=CELL:tel:+7931',
      ' 5550011',
      'END:VCARD',
      'BEGIN:VCARD',
      'TEL:12',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcard(file)).toEqual([['+7 921 123-45-67', '8 (911) 765-43-21'], ['+79315550011']]);
    // rubbish and an empty file give nothing
    expect(parseVcard('')).toEqual([]);
    expect(parseVcard('TEL:+79211234567')).toEqual([]);
    // no more than a person can have on the server
    const many = `BEGIN:VCARD\n${Array.from({ length: 9 }, (_, i) => `TEL:+7900000000${i}`).join('\n')}\nEND:VCARD`;
    expect(parseVcard(many)[0]).toHaveLength(5);
  });
});
