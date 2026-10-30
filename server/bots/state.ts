import { db, now } from '../db.js';
import type { BotRow } from './store.js';

/** Where a person is in a conversation with a built-in bot ("send me the new name"): one row per bot and person. */
export interface BotState {
  state: string;
  data: Record<string, unknown>;
}

export function getState(bot: BotRow, userId: number): BotState | null {
  const r = db.prepare('SELECT state, data FROM bot_states WHERE bot_id = ? AND user_id = ?').get(bot.user_id, userId) as
    | { state: string; data: string }
    | undefined;
  if (!r) return null;
  try {
    return { state: r.state, data: JSON.parse(r.data) as Record<string, unknown> };
  } catch {
    return { state: r.state, data: {} };
  }
}

export function setState(bot: BotRow, userId: number, state: string, data: Record<string, unknown> = {}) {
  db.prepare(
    `INSERT INTO bot_states (bot_id, user_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(bot.user_id, userId, state, JSON.stringify(data), now());
}

export function clearState(bot: BotRow, userId: number) {
  db.prepare('DELETE FROM bot_states WHERE bot_id = ? AND user_id = ?').run(bot.user_id, userId);
}
