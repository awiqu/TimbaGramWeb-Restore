import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { initDb } from '../src/db.js';
import { getOrCreatePrivate } from '../src/services/chats.js';

it('people a user already writes to stay in the contacts after the update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-contacts-mig-'));
  const file = path.join(dir, 'x.db');
  const db = initDb(file);
  const mk = (name: string) =>
    Number(db.prepare(`INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', 1)`).run(name).lastInsertRowid);
  const [a, b] = [mk('mig_a'), mk('mig_b')];
  mk('mig_stranger');
  const row = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as never;
  getOrCreatePrivate(row(a), row(b));
  getOrCreatePrivate(row(a), row(a)); // "Избранное" is a chat with oneself
  db.close();

  // the database as it was before the contacts table
  const old = new Database(file);
  old.exec('DROP TABLE user_contacts');
  old.pragma('user_version = 27');
  old.close();

  const migrated = initDb(file);
  expect(migrated.prepare('SELECT user_id, contact_id FROM user_contacts ORDER BY user_id, contact_id').all()).toEqual([
    { user_id: a, contact_id: b },
    { user_id: b, contact_id: a },
  ]);
  migrated.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
