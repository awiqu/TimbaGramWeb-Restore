import crypto from 'node:crypto';
import type { CallSignal, GroupCallInfo, GroupCallJoinResult, GroupCallParticipant } from '@timba/shared';
import { EV, GROUP_CALL_MAX } from '@timba/shared';
import type { Socket } from 'socket.io';
import { busyInCall, iceServers } from './calls.js';
import { db, now } from './db.js';
import { getChat, getMember } from './permissions.js';
import { toChat, toSocket } from './realtime.js';
import { logGroupCall } from './services/callLog.js';
import { serviceMessage } from './services/chats.js';
import { getUserRow, userDTOFor } from './serialize.js';
import { txt } from './strings.js';

/**
 * Group calls: every participant talks to every other one directly (a WebRTC mesh), which holds up
 * to about ten people without a media server. A room lives in memory while somebody is in it.
 * It belongs either to a group chat (`chat:<id>`) or to a link (`link:<token>`, the call_links table).
 */
interface Member {
  peerId: string;
  userId: number;
  mic: boolean;
  cam: boolean;
  screen: boolean;
  joinedAt: number;
}

interface Room {
  key: string;
  chatId: number | null;
  title: string;
  startedAt: number;
  /** the socket that started the call: an outgoing call in its history */
  startedBy: string;
  members: Map<string, Member>;
}

interface LinkRow {
  token: string;
  creator_id: number | null;
  title: string;
  created_at: number;
}

const rooms = new Map<string, Room>();
/** socket id → room key */
const roomOfSocket = new Map<string, string>();

export const inGroupCall = (userId: number) => [...rooms.values()].some((r) => [...r.members.values()].some((m) => m.userId === userId));

function info(room: Room): GroupCallInfo {
  const userIds = [...new Set([...room.members.values()].map((m) => m.userId))];
  return { key: room.key, chatId: room.chatId, title: room.title, startedAt: room.startedAt, count: room.members.size, userIds };
}

/** The banner in the group chat ("Идёт звонок · 3 участника"). */
function announce(room: Room) {
  if (room.chatId) toChat(room.chatId, EV.groupCallState, { chatId: room.chatId, call: room.members.size ? info(room) : null });
}

function participant(m: Member, viewerId: number): GroupCallParticipant | null {
  const u = getUserRow(m.userId);
  return u ? { peerId: m.peerId, user: userDTOFor(u, viewerId), mic: m.mic, cam: m.cam, screen: m.screen } : null;
}

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function leave(socket: Socket) {
  const key = roomOfSocket.get(socket.id);
  if (!key) return;
  roomOfSocket.delete(socket.id);
  const room = rooms.get(key);
  const member = room?.members.get(socket.id);
  if (!room || !member) return;
  room.members.delete(socket.id);
  socket.leave(`gcall:${key}`);
  logGroupCall(member.userId, room.chatId, room.chatId ? null : key.slice('link:'.length), room.title, room.startedBy === socket.id, member.joinedAt);
  for (const m of room.members.values()) toSocket(m.peerId, EV.groupCallLeft, { key, peerId: socket.id });
  if (!room.members.size) {
    rooms.delete(key);
    if (room.chatId && getChat(room.chatId)) serviceMessage(room.chatId, null, txt.labels.groupCallEnded(formatDuration(now() - room.startedAt)));
  }
  announce(room);
}

export function linkCall(token: string): LinkRow | undefined {
  return db.prepare('SELECT * FROM call_links WHERE token = ?').get(token) as LinkRow | undefined;
}

export function createLinkCall(creatorId: number, title: string): LinkRow {
  const token = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO call_links (token, creator_id, title, created_at) VALUES (?, ?, ?, ?)').run(token, creatorId, title, now());
  return linkCall(token)!;
}

/** How many are talking by the link right now (the join screen shows it). */
export const linkCallCount = (token: string) => rooms.get(`link:${token}`)?.members.size ?? 0;

function join(uid: number, socket: Socket, data: { chatId?: unknown; token?: unknown }): GroupCallJoinResult {
  const fail = (error: string): GroupCallJoinResult => ({ ok: false, error });
  const me = getUserRow(uid);
  if (!me || socket.data.stealth) return fail(txt.errors.callUnavailable);

  let key: string;
  let chatId: number | null = null;
  let title: string;
  if (data?.chatId !== undefined) {
    const chat = getChat(Number(data.chatId));
    if (!chat || chat.type !== 'group' || !getMember(chat.id, uid)) return fail(txt.errors.groupCallNotMember);
    key = `chat:${chat.id}`;
    chatId = chat.id;
    title = chat.title ?? '';
  } else {
    const link = linkCall(String(data?.token ?? ''));
    if (!link) return fail(txt.errors.callLinkInvalid);
    key = `link:${link.token}`;
    title = link.title;
  }

  if (roomOfSocket.get(socket.id) === key) leave(socket);
  if (roomOfSocket.has(socket.id) || busyInCall(uid) || inGroupCall(uid)) return fail(txt.errors.callYouBusy);

  let room = rooms.get(key);
  if (room && room.members.size >= GROUP_CALL_MAX) return fail(txt.errors.groupCallFull(GROUP_CALL_MAX));
  if (!room) {
    room = { key, chatId, title, startedAt: now(), startedBy: socket.id, members: new Map() };
    rooms.set(key, room);
    if (chatId) serviceMessage(chatId, uid, txt.labels.groupCallStarted);
  }
  const participants = [...room.members.values()].map((m) => participant(m, uid)).filter((p): p is GroupCallParticipant => !!p);
  const self: Member = { peerId: socket.id, userId: uid, mic: true, cam: false, screen: false, joinedAt: now() };
  room.members.set(socket.id, self);
  roomOfSocket.set(socket.id, key);
  socket.join(`gcall:${key}`);
  for (const m of room.members.values()) {
    if (m.peerId === socket.id) continue;
    const p = participant(self, m.userId);
    if (p) toSocket(m.peerId, EV.groupCallJoined, { key, participant: p });
  }
  announce(room);
  return { ok: true, key, chatId, title, startedAt: room.startedAt, selfPeerId: socket.id, participants, iceServers: iceServers(uid) };
}

/** Wire the group call events into a freshly connected socket. */
export function attachGroupCalls(socket: Socket, uid: number) {
  // the banners of the calls going on in the user's groups
  for (const room of rooms.values()) {
    if (room.chatId && getMember(room.chatId, uid)) socket.emit(EV.groupCallState, { chatId: room.chatId, call: info(room) });
  }

  socket.on('gcall:join', (data: { chatId?: unknown; token?: unknown }, ack?: (r: GroupCallJoinResult) => void) => {
    const r = join(uid, socket, data);
    if (typeof ack === 'function') ack(r);
  });

  socket.on('gcall:leave', () => leave(socket));

  socket.on('gcall:signal', (data: { to?: unknown; signal?: CallSignal }) => {
    const key = roomOfSocket.get(socket.id);
    const to = String(data?.to ?? '');
    if (!key || !data?.signal || typeof data.signal !== 'object' || roomOfSocket.get(to) !== key) return;
    toSocket(to, EV.groupCallSignal, { key, from: socket.id, signal: data.signal });
  });

  socket.on('gcall:media', (data: { mic?: unknown; cam?: unknown; screen?: unknown }) => {
    const key = roomOfSocket.get(socket.id);
    const me = key ? rooms.get(key)?.members.get(socket.id) : undefined;
    if (!key || !me) return;
    me.mic = !!data?.mic;
    me.cam = !!data?.cam;
    me.screen = !!data?.screen;
    socket.to(`gcall:${key}`).emit(EV.groupCallMedia, { key, peerId: socket.id, mic: me.mic, cam: me.cam, screen: me.screen });
  });

  socket.on('disconnect', () => leave(socket));
}

/** tests */
export const activeGroupCalls = () => rooms.size;
