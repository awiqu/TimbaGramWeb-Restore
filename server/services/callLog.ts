import type { CallLogEntry, CallLogStatus } from '@timba/shared';
import { db, now } from '../db.js';
import { getUserRow, userDTOFor } from '../serialize.js';

/**
 * The "Звонки" tab: every participant gets their own row, so each side sees the call from their
 * point of view (incoming / outgoing, missed / cancelled).
 */
interface Row {
  id: number;
  user_id: number;
  kind: 'private' | 'group';
  peer_id: number | null;
  chat_id: number | null;
  link_token: string | null;
  title: string;
  outgoing: number;
  video: number;
  status: CallLogStatus;
  started_at: number;
  duration: number;
}

function insert(r: Omit<Row, 'id'>) {
  db.prepare(
    `INSERT INTO call_log (user_id, kind, peer_id, chat_id, link_token, title, outgoing, video, status, started_at, duration)
     VALUES (@user_id, @kind, @peer_id, @chat_id, @link_token, @title, @outgoing, @video, @status, @started_at, @duration)`,
  ).run(r);
}

/** A one-to-one call that has ended. `reason` is why it ended, `answeredAt` null when nobody picked up. */
export function logPrivateCall(
  callerId: number,
  calleeId: number,
  video: boolean,
  startedAt: number,
  answeredAt: number | null,
  reason: string,
) {
  const duration = answeredAt !== null ? Math.max(1, Math.round((now() - answeredAt) / 1000)) : 0;
  const base = { kind: 'private' as const, chat_id: null, link_token: null, title: '', video: video ? 1 : 0, started_at: startedAt, duration };
  if (answeredAt !== null) {
    insert({ ...base, user_id: callerId, peer_id: calleeId, outgoing: 1, status: 'answered' });
    insert({ ...base, user_id: calleeId, peer_id: callerId, outgoing: 0, status: 'answered' });
    return;
  }
  const callerStatus: CallLogStatus = reason === 'ended' ? 'cancelled' : reason === 'declined' ? 'declined' : reason === 'busy' ? 'busy' : 'noanswer';
  insert({ ...base, user_id: callerId, peer_id: calleeId, outgoing: 1, status: callerStatus });
  insert({ ...base, user_id: calleeId, peer_id: callerId, outgoing: 0, status: reason === 'declined' ? 'declined' : 'missed' });
}

/** Somebody left a group call: how long they talked. */
export function logGroupCall(userId: number, chatId: number | null, token: string | null, title: string, started: boolean, joinedAt: number) {
  insert({
    user_id: userId,
    kind: 'group',
    peer_id: null,
    chat_id: chatId,
    link_token: token,
    title,
    outgoing: started ? 1 : 0,
    video: 0,
    status: 'answered',
    started_at: joinedAt,
    duration: Math.max(1, Math.round((now() - joinedAt) / 1000)),
  });
}

export function callHistory(viewerId: number, missedOnly: boolean): CallLogEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM call_log WHERE user_id = ? ${missedOnly ? "AND status = 'missed'" : ''} ORDER BY started_at DESC LIMIT 200`,
    )
    .all(viewerId) as Row[];
  const out: CallLogEntry[] = [];
  for (const r of rows) {
    const peer = r.peer_id ? getUserRow(r.peer_id) : undefined;
    if (r.kind === 'private' && !peer) continue;
    out.push({
      id: r.id,
      kind: r.kind,
      peer: peer ? userDTOFor(peer, viewerId) : null,
      chatId: r.chat_id,
      linkToken: r.link_token,
      title: r.title,
      outgoing: !!r.outgoing,
      video: !!r.video,
      status: r.status,
      startedAt: r.started_at,
      duration: r.duration,
    });
  }
  return out;
}

export function clearCallHistory(viewerId: number) {
  db.prepare('DELETE FROM call_log WHERE user_id = ?').run(viewerId);
}
