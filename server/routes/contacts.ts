import { CONTACTS_IMPORT_CHUNK, type ImportContactsResult, type UserDTO, addContactSchema, importContactsSchema, normalizePhone } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAuth } from '../auth.js';
import { db, now } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { type UserRow, userDTOFor } from '../serialize.js';
import { txt } from '../strings.js';
import { intParam, parse } from '../util.js';

/** A phone number that can belong to somebody: "+" and 10–15 digits */
const PHONE_RE = /^\+\d{10,15}$/;
/** SQLite takes tens of thousands of parameters, a few hundred per query is plenty */
const LOOKUP_BATCH = 400;

/**
 * "Контакты" are the people a user saved: one by one (a profile, the search) or from the phone book,
 * where a person is found by the number. The numbers of the book are only looked up, never stored.
 */
export default async function contactRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/contacts', async (req) => {
    const rows = db
      .prepare(
        `SELECT u.* FROM user_contacts c JOIN users u ON u.id = c.contact_id
         WHERE c.user_id = ? AND u.is_banned = 0 AND u.bot IS NULL AND u.is_bot = 0
         ORDER BY u.first_name, u.last_name, u.username`,
      )
      .all(req.auth.user.id) as UserRow[];
    return rows.map((u) => userDTOFor(u, req.auth.user.id));
  });

  app.post('/api/contacts', async (req): Promise<UserDTO> => {
    const me = req.auth.user;
    const { userId } = parse(addContactSchema, req.body);
    if (userId === me.id) throw badRequest(txt.errors.cannotContactSelf);
    const target = db.prepare('SELECT *, bot FROM users WHERE id = ? AND is_banned = 0').get(userId) as (UserRow & { bot: string | null }) | undefined;
    if (!target) throw notFound(txt.errors.userNotFound);
    if (target.is_bot || target.bot) throw badRequest(txt.errors.cannotContactBot);
    db.prepare('INSERT OR IGNORE INTO user_contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)').run(me.id, target.id, now());
    return userDTOFor(target, me.id);
  });

  app.delete<{ Params: { id: string } }>('/api/contacts/:id', async (req) => {
    db.prepare('DELETE FROM user_contacts WHERE user_id = ? AND contact_id = ?').run(req.auth.user.id, intParam(req.params.id));
    return { ok: true };
  });

  /**
   * The phone book as lists of numbers, one list per person. Everybody found by a number becomes a contact.
   * Anyone can already be found by the whole number in the search, so this tells nothing new, but a lot of
   * numbers at once is limited: the book is sent in parts of CONTACTS_IMPORT_CHUNK people.
   */
  app.post('/api/contacts/import', async (req): Promise<ImportContactsResult> => {
    const me = req.auth.user;
    rateLimit(`contacts-import:${me.id}`, 20, 3600_000);
    const { contacts } = parse(importContactsSchema, req.body);

    // one list of valid numbers per person; the own number and people without a number are not counted
    const people: string[][] = [];
    for (const raw of contacts) {
      const phones = [...new Set(raw.map(normalizePhone).filter((p) => PHONE_RE.test(p)))];
      if (phones.length && !phones.every((p) => p === me.phone)) people.push(phones);
    }
    if (people.length > CONTACTS_IMPORT_CHUNK) throw badRequest(txt.errors.invalidData);

    const owner = new Map<string, UserRow>();
    const all = [...new Set(people.flat())];
    for (let i = 0; i < all.length; i += LOOKUP_BATCH) {
      const part = all.slice(i, i + LOOKUP_BATCH);
      const rows = db
        .prepare(`SELECT * FROM users WHERE phone IN (${part.map(() => '?').join(',')}) AND is_banned = 0 AND bot IS NULL AND is_bot = 0 AND id != ?`)
        .all(...part, me.id) as UserRow[];
      for (const u of rows) owner.set(u.phone!, u);
    }

    const matched = new Map<number, UserRow>();
    let found = 0;
    for (const phones of people) {
      const hit = phones.map((p) => owner.get(p)).find(Boolean);
      if (!hit) continue;
      found++;
      matched.set(hit.id, hit);
    }

    const added: UserDTO[] = [];
    const insert = db.prepare('INSERT OR IGNORE INTO user_contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)');
    db.transaction(() => {
      const at = now();
      for (const u of matched.values()) if (insert.run(me.id, u.id, at).changes) added.push(userDTOFor(u, me.id));
    })();
    return { found, total: people.length, added };
  });
}
