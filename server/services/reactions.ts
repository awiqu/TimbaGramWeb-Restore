import type { ReactionDTO, ReactionsEvent, ReactorDTO } from '@timba/shared';
import { EV } from '@timba/shared';
import { isAdmin } from '../auth.js';
import { db, now } from '../db.js';
import { botHooks } from '../bots/hooks.js';
import { forbidden, notFound } from '../errors.js';
import { getMember, requireView } from '../permissions.js';
import { toChat } from '../realtime.js';
import { type UserRow, getMessageRow, messageDTO, userDTO, usersByIds } from '../serialize.js';
import { txt } from '../strings.js';

function requireReactable(messageId: number, user: UserRow) {
  const m = getMessageRow(messageId);
  if (!m || m.kind === 'service') throw notFound(txt.errors.messageNotFound);
  const chat = requireView(m.chat_id, user);
  return { m, chat };
}

/** Set (or with `emoji = null` remove) the user's reaction. Returns the viewer's view of the reactions. */
export function setReaction(messageId: number, user: UserRow, emoji: string | null): ReactionDTO[] {
  const { m, chat } = requireReactable(messageId, user);
  if (!getMember(chat.id, user.id) && !isAdmin(user)) throw forbidden(txt.errors.notMember);
  if (chat.type !== 'private' && !chat.reactions_enabled) throw forbidden(txt.errors.reactionsOff);
  const before = (
    db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?').get(m.id, user.id) as { emoji: string } | undefined
  )?.emoji ?? null;
  if (emoji) {
    db.prepare(
      `INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
    ).run(m.id, user.id, emoji, now());
  } else {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
  }
  const ev: ReactionsEvent = { chatId: chat.id, messageId: m.id, reactions: messageDTO(m).reactions, userId: user.id, emoji };
  toChat(chat.id, EV.reactions, ev);
  if (before !== emoji) botHooks.reaction(chat, user, m, before, emoji);
  return messageDTO(m, user.id).reactions;
}

/** Who reacted with what. Channel posts are anonymous. */
export function listReactors(messageId: number, user: UserRow): ReactorDTO[] {
  const { m, chat } = requireReactable(messageId, user);
  if (chat.type === 'channel' && m.thread_id === null) throw forbidden(txt.errors.reactionsAnonymous);
  const rows = db
    .prepare('SELECT user_id, emoji FROM message_reactions WHERE message_id = ? ORDER BY created_at DESC')
    .all(m.id) as { user_id: number; emoji: string }[];
  const users = usersByIds(rows.map((r) => r.user_id));
  return rows.filter((r) => users.has(r.user_id)).map((r) => ({ user: userDTO(users.get(r.user_id)!), emoji: r.emoji }));
}
