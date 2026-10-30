import type { Server as HttpServer } from 'node:http';
import { EV } from '@timba/shared';
import { Server } from 'socket.io';
import { attachCalls } from './calls.js';
import { attachGroupCalls } from './groupCalls.js';
import { SESSION_COOKIE, assertAccess, resolveToken } from './auth.js';
import { db, now } from './db.js';
import { DEVICE_COOKIE, assertDevice, deviceFromCookies } from './devices.js';
import { HttpError } from './errors.js';
import { canView, getChat, getMember, membership } from './permissions.js';
import { chatRoom, markOffline, markOnline, setIo, setSocketActive, toAllExcept, toUser, userRoom } from './realtime.js';
import { blockedIdsOf, getUserRow, lastSeenApprox, parsePrivacy } from './serialize.js';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const value = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(value);
    } catch {
      // a malformed cookie must not break the handshake
      out[part.slice(0, i).trim()] = value;
    }
  }
  return out;
}

/** Online/offline, respecting "last seen" privacy and blocks. */
function broadcastPresence(uid: number, online: boolean, lastSeenAt: number) {
  const u = getUserRow(uid);
  if (!u) return;
  const hidden = { userId: uid, online: false, lastSeenAt: null, lastSeenApprox: lastSeenApprox(online, lastSeenAt) };
  const blocked = blockedIdsOf(uid);
  if (parsePrivacy(u).lastSeen === 'nobody') {
    toAllExcept([...blocked, uid], EV.presence, hidden);
  } else {
    toAllExcept([...blocked, uid], EV.presence, { userId: uid, online, lastSeenAt, lastSeenApprox: null });
  }
  for (const id of blocked) toUser(id, EV.presence, { ...hidden, lastSeenApprox: 'long' });
}

export function attachSocket(server: HttpServer): Server {
  const io = new Server(server, { serveClient: false, maxHttpBufferSize: 1e5 });
  setIo(io);

  io.use((socket, next) => {
    const auth = resolveToken(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);
    if (!auth) return next(new Error('unauthorized'));
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const deviceId = deviceFromCookies({ [DEVICE_COOKIE]: cookies[DEVICE_COOKIE] });
    try {
      assertAccess(auth.user, auth.session);
      if (deviceId) assertDevice(deviceId, auth.user, auth.session);
    } catch (e) {
      return next(new Error(e instanceof HttpError ? e.code : 'forbidden'));
    }
    socket.data.deviceId = deviceId;
    socket.data.userId = auth.user.id;
    socket.data.sessionId = auth.session.id;
    // the admin signed in as the user stays invisible: no online status
    socket.data.stealth = !!auth.session.impersonator_id;
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.data.userId as number;
    const stealth = !!socket.data.stealth;
    socket.join(userRoom(uid));
    const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(uid) as { chat_id: number }[];
    for (const c of chats) socket.join(chatRoom(c.chat_id));

    if (!stealth && markOnline(uid)) broadcastPresence(uid, true, now());
    attachCalls(socket, uid);
    attachGroupCalls(socket, uid);

    socket.on('typing', (data: { chatId?: number; action?: string }) => {
      const chatId = Number(data?.chatId);
      if (!chatId || !socket.rooms.has(chatRoom(chatId))) return;
      const chat = getChat(chatId);
      const user = getUserRow(uid);
      // nobody sees who is typing a channel post
      if (!chat || !user || chat.type === 'channel' || !membership(chat, user).canSend) return;
      const action = data?.action === 'voice' || data?.action === 'round' ? data.action : undefined;
      socket.to(chatRoom(chatId)).emit(EV.typing, { chatId, userId: uid, ...(action ? { action } : {}) });
    });

    // subscribe to a chat you are not a member of (public group preview / global admin)
    socket.on('chat:watch', (data: { chatId?: number }) => {
      const chatId = Number(data?.chatId);
      const chat = chatId ? getChat(chatId) : undefined;
      const user = getUserRow(uid);
      if (chat && user && canView(chat, user)) socket.join(chatRoom(chatId));
    });

    socket.on('chat:unwatch', (data: { chatId?: number }) => {
      const chatId = Number(data?.chatId);
      if (chatId && !getMember(chatId, uid)) socket.leave(chatRoom(chatId));
    });

    // the tab is visible: this user reads messages live and needs no push notifications
    // (the admin watching as the user does not count: the real user still needs their pushes)
    socket.on('client:active', (data: { active?: boolean }) => !stealth && setSocketActive(uid, socket.id, !!data?.active));

    socket.on('disconnect', () => {
      setSocketActive(uid, socket.id, false);
      if (!stealth && markOffline(uid)) {
        const t = now();
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(t, uid);
        broadcastPresence(uid, false, t);
      }
    });
  });

  return io;
}
