import { CONTACT_PHONES_MAX } from './constants.js';

/**
 * The phone numbers of a vCard file (.vcf: what «Экспортировать» in the iPhone's contacts, Google Contacts and
 * most address books make): one list per card, the numbers as they are written there. Names, photos, e-mails and
 * everything else in the file are skipped here, so they never have to leave the phone.
 */
export function parseVcard(text: string): string[][] {
  // a line that starts with a space or a tab continues the one before it
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const people: string[][] = [];
  let card: string[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) {
      card = [];
      continue;
    }
    if (/^END:VCARD/i.test(line)) {
      if (card?.length) people.push([...new Set(card)].slice(0, CONTACT_PHONES_MAX));
      card = null;
      continue;
    }
    if (!card) continue;
    // "TEL:+7…", "TEL;TYPE=CELL:+7…", and the grouped form Apple writes: "item1.TEL;type=pref:+7…"
    const m = /^(?:[\w-]+\.)?TEL(?:;[^:]*)?:(.*)$/i.exec(line);
    if (!m) continue;
    const value = m[1]!.trim().replace(/^tel:/i, '');
    // (digits with spaces, dashes and brackets between them: five of them make a number, fewer is a short code)
    if (value.replace(/\D/g, '').length >= 5) card.push(value.slice(0, 40));
  }
  return people;
}
