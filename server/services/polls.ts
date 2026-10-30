import type { PollVotersDTO } from '@timba/shared';
import { EV } from '@timba/shared';
import { isAdmin } from '../auth.js';
import { db, now } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { botHooks } from '../bots/hooks.js';
import { assertSlowMode, getMember, isChannel, membership, requireView } from '../permissions.js';
import { toChat, toUser } from '../realtime.js';
import { type PollRow, type UserRow, getMessageRow, pollsDTO, userDTO, usersByIds } from '../serialize.js';
import { txt } from '../strings.js';
import { assertNotBlocked, insertMessage, publishMessage, replyTarget } from './messages.js';

export interface CreatePollInput {
  question: string;
  options: string[];
  anonymous: boolean;
  multiple: boolean;
  quiz: boolean;
  correctOption: number | null;
  explanation: string;
  closePeriod: number | null;
  replyToId?: number | null;
  clientId?: string;
  /** a bot's inline keyboard: JSON of InlineKeyboardDTO */
  replyMarkup?: string | null;
}

function getPoll(id: number): PollRow | undefined {
  return db.prepare('SELECT * FROM polls WHERE id = ?').get(id) as PollRow | undefined;
}

/** Chats that contain a message with this poll (a forwarded poll lives in several chats). */
function pollChats(pollId: number): number[] {
  return (db.prepare('SELECT DISTINCT chat_id FROM messages WHERE poll_id = ?').all(pollId) as { chat_id: number }[]).map(
    (r) => r.chat_id,
  );
}

/** Public poll state to every chat that shows it; the acting user also gets their personal view. */
function broadcastPoll(pollId: number, actorId?: number) {
  const pub = pollsDTO([pollId]).get(pollId);
  if (!pub) return;
  for (const chatId of pollChats(pollId)) toChat(chatId, EV.pollUpdate, pub);
  if (actorId !== undefined) toUser(actorId, EV.pollUpdate, pollsDTO([pollId], actorId).get(pollId));
  botHooks.pollChanged(pollId);
}

export function createPoll(chatId: number, user: UserRow, input: CreatePollInput) {
  const chat = requireView(chatId, user);
  const me = membership(chat, user);
  if (!me.canSend) throw forbidden(me.mutedUntil ? txt.errors.cannotWriteMuted : txt.errors.cannotWrite);
  if (!me.canSendPolls) throw forbidden(txt.errors.pollsForbidden);
  assertNotBlocked(chat, user);
  assertSlowMode(chat, user);
  const quiz = input.quiz;
  const t = now();
  const res = db
    .prepare(
      `INSERT INTO polls (creator_id, question, options, anonymous, multiple, quiz, correct_option, explanation, close_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      input.question,
      JSON.stringify(input.options),
      // channel subscribers are anonymous to each other, so are their votes
      input.anonymous || isChannel(chat) ? 1 : 0,
      !quiz && input.multiple ? 1 : 0,
      quiz ? 1 : 0,
      quiz ? input.correctOption : null,
      quiz ? input.explanation : '',
      input.closePeriod ? t + input.closePeriod * 1000 : null,
      t,
    );
  const row = insertMessage(chat, user, {
    text: '',
    files: [],
    replyToId: replyTarget(chat, input.replyToId),
    pollId: Number(res.lastInsertRowid),
    replyMarkup: input.replyMarkup,
  });
  return publishMessage(chat, user, row, input.clientId);
}

function requirePollMessage(messageId: number, user: UserRow) {
  const m = getMessageRow(messageId);
  if (!m || !m.poll_id) throw notFound(txt.errors.pollNotFound);
  const chat = requireView(m.chat_id, user);
  const poll = getPoll(m.poll_id);
  if (!poll) throw notFound(txt.errors.pollNotFound);
  return { m, chat, poll };
}

const isExpired = (p: PollRow) => !!p.closed || (p.close_at !== null && p.close_at <= now());

export function votePoll(messageId: number, user: UserRow, options: number[]) {
  const { chat, poll } = requirePollMessage(messageId, user);
  // members vote (even if they may not write); previewing a public chat is read-only
  if (!getMember(chat.id, user.id) && !isAdmin(user)) throw forbidden(txt.errors.notMember);
  if (isExpired(poll)) {
    closeExpiredPolls();
    throw badRequest(txt.errors.pollClosed, 'poll_closed');
  }
  const count = (JSON.parse(poll.options) as string[]).length;
  const picked = [...new Set(options)];
  if (picked.some((i) => i >= count)) throw badRequest(txt.errors.pollBadOption);
  if (picked.length > 1 && !poll.multiple) throw badRequest(poll.quiz ? txt.errors.quizOneAnswer : txt.errors.pollSingleAnswer);
  const hasVote = !!db.prepare('SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ? LIMIT 1').get(poll.id, user.id);
  if (poll.quiz && hasVote) throw badRequest(txt.errors.quizNoRetract);

  const t = now();
  db.transaction(() => {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, user.id);
    const ins = db.prepare('INSERT INTO poll_votes (poll_id, user_id, option_idx, created_at) VALUES (?, ?, ?, ?)');
    for (const i of picked) ins.run(poll.id, user.id, i, t);
  })();
  botHooks.pollAnswer(poll.id, user, picked);
  broadcastPoll(poll.id, user.id);
  return pollsDTO([poll.id], user.id).get(poll.id)!;
}

export function stopPoll(messageId: number, user: UserRow) {
  const { m, chat, poll } = requirePollMessage(messageId, user);
  const me = membership(chat, user);
  const allowed =
    poll.creator_id === user.id ||
    (m.sender_id === user.id && me.canSend) ||
    me.rights.deleteMessages ||
    (isChannel(chat) && me.rights.editMessages);
  if (!allowed) throw forbidden(txt.errors.cannotStopPoll);
  if (!poll.closed) {
    db.prepare('UPDATE polls SET closed = 1 WHERE id = ?').run(poll.id);
    broadcastPoll(poll.id);
  }
  return pollsDTO([poll.id], user.id).get(poll.id)!;
}

export function pollVoters(messageId: number, user: UserRow): PollVotersDTO[] {
  const { poll } = requirePollMessage(messageId, user);
  if (poll.anonymous) throw forbidden(txt.errors.pollAnonymous);
  const votes = db
    .prepare('SELECT user_id, option_idx FROM poll_votes WHERE poll_id = ? ORDER BY created_at')
    .all(poll.id) as { user_id: number; option_idx: number }[];
  const users = usersByIds(votes.map((v) => v.user_id));
  const count = (JSON.parse(poll.options) as string[]).length;
  return Array.from({ length: count }, (_, option) => ({
    option,
    users: votes
      .filter((v) => v.option_idx === option && users.has(v.user_id))
      .map((v) => userDTO(users.get(v.user_id)!)),
  }));
}

/** Close polls whose time is up and tell the chats. */
export function closeExpiredPolls() {
  const due = db
    .prepare('SELECT id, question FROM polls WHERE closed = 0 AND close_at IS NOT NULL AND close_at <= ?')
    .all(now()) as { id: number; question: string }[];
  for (const p of due) {
    db.prepare('UPDATE polls SET closed = 1 WHERE id = ?').run(p.id);
    broadcastPoll(p.id);
  }
  return due.length;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startPollTimer() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      closeExpiredPolls();
    } catch {
      /* db closed during shutdown */
    }
  }, 10_000);
  timer.unref();
}
