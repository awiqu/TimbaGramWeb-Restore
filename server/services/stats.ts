import type { ChatStatsDTO, StatsDay, StatsPost } from '@timba/shared';
import { db, now } from '../db.js';
import type { ChatRow } from '../permissions.js';
import { type MessageRow, type UserRow, messagesDTO, userDTO, usersByIds } from '../serialize.js';
import { shownMemberCount } from './chats.js';

const DAY = 86400_000;
const DAYS = 30;
const POSTS = 20;

/**
 * Statistics of a group or channel for its admins, like Telegram's: subscribers by day
 * (from the join/leave log), messages or posts by day, reach of the latest posts, active members.
 * tzOffset is the viewer's Date.getTimezoneOffset(), so days start at their midnight.
 */
export function chatStats(chat: ChatRow, viewer: UserRow, tzOffset: number): ChatStatsDTO {
  const t = now();
  const shift = tzOffset * 60_000;
  // local time = UTC - offset, so local midnight is at floor((ts - shift) / DAY) * DAY + shift
  const dayStart = (ts: number) => Math.floor((ts - shift) / DAY) * DAY + shift;
  const today = dayStart(t);
  const from = today - (DAYS - 1) * DAY;

  const real = (db.prepare('SELECT COUNT(*) c FROM chat_members WHERE chat_id = ?').get(chat.id) as { c: number }).c;
  const log = db
    .prepare('SELECT delta, at FROM chat_member_log WHERE chat_id = ? AND at >= ? ORDER BY at')
    .all(chat.id, from - 14 * DAY) as { delta: number; at: number }[];
  /** members at a moment: today's count minus what happened after it */
  const membersAt = (ts: number) =>
    shownMemberCount(chat, real - log.filter((e) => e.at > ts).reduce((a, e) => a + e.delta, 0));

  const channel = chat.type === 'channel';
  const perDay = new Map(
    (
      db
        .prepare(
          `SELECT CAST((created_at - @from) / ${DAY} AS INTEGER) d, COUNT(*) c FROM messages
           WHERE chat_id = @chat AND created_at >= @from AND kind != 'service' AND thread_id IS NULL GROUP BY d`,
        )
        .all({ chat: chat.id, from }) as { d: number; c: number }[]
    ).map((r) => [r.d, r.c]),
  );

  const days: StatsDay[] = [];
  for (let i = 0; i < DAYS; i++) {
    const start = from + i * DAY;
    const end = start + DAY;
    const inDay = log.filter((e) => e.at >= start && e.at < end);
    days.push({
      day: start,
      members: membersAt(Math.min(end, t)),
      joins: inDay.filter((e) => e.delta > 0).length,
      leaves: inDay.filter((e) => e.delta < 0).length,
      messages: perDay.get(i) ?? 0,
    });
  }

  let posts: StatsPost[] = [];
  if (channel) {
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND thread_id IS NULL AND kind != 'service'
         ORDER BY id DESC LIMIT ${POSTS}`,
      )
      .all(chat.id) as MessageRow[];
    const shares = new Map(
      rows.length
        ? (
            db
              .prepare(
                `SELECT message_id, COUNT(*) c FROM message_shares WHERE chat_id = ? AND message_id IN (${rows.map(() => '?').join(',')})
                 GROUP BY message_id`,
              )
              .all(chat.id, ...rows.map((r) => r.id)) as { message_id: number; c: number }[]
          ).map((r) => [r.message_id, r.c])
        : [],
    );
    posts = messagesDTO(rows, viewer.id).map((m) => ({
      message: m,
      views: m.views ?? 0,
      reactions: m.reactions.reduce((a, r) => a + r.count, 0),
      shares: shares.get(m.id) ?? 0,
      comments: m.commentCount ?? 0,
    }));
  }
  const avg = (f: (p: StatsPost) => number) => (posts.length ? Math.round((posts.reduce((a, p) => a + f(p), 0) / posts.length) * 10) / 10 : 0);

  let topMembers: ChatStatsDTO['topMembers'] = [];
  if (!channel) {
    const rows = db
      .prepare(
        `SELECT sender_id, COUNT(*) c FROM messages WHERE chat_id = ? AND created_at >= ? AND kind != 'service'
         AND sender_id IS NOT NULL GROUP BY sender_id ORDER BY c DESC LIMIT 5`,
      )
      .all(chat.id, from) as { sender_id: number; c: number }[];
    const users = usersByIds(rows.map((r) => r.sender_id));
    topMembers = rows.filter((r) => users.has(r.sender_id)).map((r) => ({ user: userDTO(users.get(r.sender_id)!), messages: r.c }));
  }

  const members = shownMemberCount(chat, real);
  return {
    type: chat.type,
    members,
    growth7: members - membersAt(t - 7 * DAY),
    growthPrev7: membersAt(t - 7 * DAY) - membersAt(t - 14 * DAY),
    joins30: days.reduce((a, d) => a + d.joins, 0),
    leaves30: days.reduce((a, d) => a + d.leaves, 0),
    messages30: days.reduce((a, d) => a + d.messages, 0),
    days,
    posts,
    avgViews: avg((p) => p.views),
    avgShares: avg((p) => p.shares),
    avgReactions: avg((p) => p.reactions),
    topMembers,
  };
}
