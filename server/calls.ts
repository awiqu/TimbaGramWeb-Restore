import crypto from 'node:crypto';
import type { CallEndReason, CallIceServer, CallIncomingEvent, CallSignal, CallStartResult } from '@timba/shared';
import { CALL_RING_MS, EV } from '@timba/shared';
import type { Socket } from 'socket.io';
import { config } from './config.js';
import { db, now } from './db.js';
import { notifyUser } from './push.js';
import { isOnline, toSocket, toUser, toUserExcept } from './realtime.js';
import { broadcastChat, getOrCreatePrivate, serviceMessage } from './services/chats.js';
import { getUserRow, isBlockedBy, userDTOFor } from './serialize.js';
import { inGroupCall } from './groupCalls.js';
import { logPrivateCall } from './services/callLog.js';
import { txt } from './strings.js';

/**
 * One-to-one calls. Audio and video go straight between the two browsers (WebRTC), or through
 * the optional TURN server; this process only passes a few small signalling messages along, so
 * a call costs it nothing but memory for one object.
 */
interface Call {
  id: string;
  startedAt: number;
  callerId: number;
  calleeId: number;
  video: boolean;
  callerSocket: string;
  /** the callee's tab that picked up; null while ringing */
  calleeSocket: string | null;
  answeredAt: number | null;
  ringTimer: NodeJS.Timeout | null;
}

const calls = new Map<string, Call>();
const callOfUser = new Map<number, string>();

/** STUN always; TURN with a password valid for a day when configured. */
export function iceServers(userId: number): CallIceServer[] {
  const list: CallIceServer[] = config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
  if (!config.turnUrls.length) return list;
  if (config.turnSecret) {
    // coturn "use-auth-secret": username = expiry:tag, password = base64(hmac-sha1(secret, username))
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    list.push({ urls: config.turnUrls, username, credential });
  } else if (config.turnUsername) {
    list.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnPassword });
  }
  return list;
}

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "📞 Звонок, 2:31" / "Пропущенный звонок" in the private chat, like Telegram's call log. */
function logCall(call: Call, reason: CallEndReason) {
  const caller = getUserRow(call.callerId);
  const callee = getUserRow(call.calleeId);
  if (!caller || !callee) return;
  const text =
    call.answeredAt !== null
      ? txt.labels.callDone(call.video, formatDuration(now() - call.answeredAt))
      : reason === 'declined'
        ? txt.labels.callDeclined(call.video)
        : txt.labels.callMissed(call.video);
  const known = db.prepare('SELECT 1 FROM chats WHERE private_key = ?').get([caller.id, callee.id].sort((a, b) => a - b).join(':'));
  const chat = getOrCreatePrivate(caller, callee);
  if (!known) broadcastChat(chat.id);
  serviceMessage(chat.id, caller.id, text);
}

function endCall(call: Call, reason: CallEndReason) {
  if (!calls.delete(call.id)) return;
  if (call.ringTimer) clearTimeout(call.ringTimer);
  // a busy callee keeps their own call
  for (const id of [call.callerId, call.calleeId]) if (callOfUser.get(id) === call.id) callOfUser.delete(id);
  // every tab of both sides: the callee's other tabs stop ringing, the side that hung up just ignores it
  const ev = { callId: call.id, reason };
  toUser(call.callerId, EV.callEnd, ev);
  toUser(call.calleeId, EV.callEnd, ev);
  logCall(call, reason);
  logPrivateCall(call.callerId, call.calleeId, call.video, call.startedAt, call.answeredAt, reason);
}

function start(uid: number, socket: Socket, data: { userId?: unknown; video?: unknown }): CallStartResult {
  const fail = (error: string): CallStartResult => ({ ok: false, error });
  const me = getUserRow(uid);
  const peer = getUserRow(Number(data?.userId));
  if (!me || !peer || peer.id === uid || peer.is_banned || socket.data.stealth) {
    return fail(txt.errors.callUnavailable);
  }
  if (peer.is_bot) return fail(txt.bots.noCalls);
  if (isBlockedBy(uid, peer.id)) return fail(txt.errors.youBlocked);
  if (isBlockedBy(peer.id, uid)) return fail(txt.errors.callUnavailable);
  if (callOfUser.has(uid) || inGroupCall(uid)) return fail(txt.errors.callYouBusy);
  if (!isOnline(peer.id) && !db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(peer.id)) {
    return fail(txt.errors.callOffline);
  }

  const call: Call = {
    id: crypto.randomUUID(),
    startedAt: now(),
    callerId: uid,
    calleeId: peer.id,
    video: !!data?.video,
    callerSocket: socket.id,
    calleeSocket: null,
    answeredAt: null,
    ringTimer: null,
  };
  calls.set(call.id, call);
  callOfUser.set(uid, call.id);

  if (callOfUser.has(peer.id) || inGroupCall(peer.id)) {
    // the line is busy: the caller hears it, the callee only sees the missed call in the chat
    setTimeout(() => endCall(call, 'busy'), 0);
    return { ok: true, callId: call.id, iceServers: iceServers(uid) };
  }
  callOfUser.set(peer.id, call.id);
  call.ringTimer = setTimeout(() => endCall(call, 'missed'), CALL_RING_MS);

  const incoming: CallIncomingEvent = { callId: call.id, from: userDTOFor(me, peer.id), video: call.video, iceServers: iceServers(peer.id) };
  toUser(peer.id, EV.callIncoming, incoming);
  // a closed tab or a phone in the pocket: the push opens the app, which then gets the call on connect
  const chat = getOrCreatePrivate(me, peer);
  notifyUser(peer.id, {
    title: [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username,
    body: txt.labels.incomingCall(call.video),
    chatId: chat.id,
    url: `/c/${chat.id}`,
    tag: `call-${call.id}`,
  });
  return { ok: true, callId: call.id, iceServers: iceServers(uid) };
}

/** Wire the call events into a freshly connected socket. */
export function attachCalls(socket: Socket, uid: number) {
  // the callee opened the app from the push (or a second tab) while it is still ringing
  const pending = callOfUser.get(uid);
  const ringing = pending ? calls.get(pending) : undefined;
  if (ringing && ringing.calleeId === uid && !ringing.calleeSocket && !socket.data.stealth) {
    const from = getUserRow(ringing.callerId);
    if (from) {
      const ev: CallIncomingEvent = { callId: ringing.id, from: userDTOFor(from, uid), video: ringing.video, iceServers: iceServers(uid) };
      socket.emit(EV.callIncoming, ev);
    }
  }

  const own = (callId: unknown) => {
    const call = calls.get(String(callId));
    return call && (call.callerId === uid || call.calleeId === uid) ? call : undefined;
  };

  socket.on('call:start', (data: { userId?: unknown; video?: unknown }, ack?: (r: CallStartResult) => void) => {
    const r = start(uid, socket, data);
    if (typeof ack === 'function') ack(r);
  });

  socket.on('call:accept', (data: { callId?: unknown }) => {
    const call = own(data?.callId);
    if (!call || call.calleeId !== uid || call.calleeSocket || socket.data.stealth) return;
    call.calleeSocket = socket.id;
    call.answeredAt = now();
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.ringTimer = null;
    // the callee's other tabs stop ringing
    toUserExcept(uid, socket.id, EV.callEnd, { callId: call.id, reason: 'answered_elsewhere' });
    toSocket(call.callerSocket, EV.callAccepted, { callId: call.id });
  });

  socket.on('call:decline', (data: { callId?: unknown }) => {
    const call = own(data?.callId);
    if (call && call.calleeId === uid && !call.calleeSocket) endCall(call, 'declined');
  });

  socket.on('call:hangup', (data: { callId?: unknown }) => {
    const call = own(data?.callId);
    if (call) endCall(call, 'ended');
  });

  socket.on('call:signal', (data: { callId?: unknown; signal?: CallSignal }) => {
    const call = own(data?.callId);
    if (!call || !call.calleeSocket || !data?.signal || typeof data.signal !== 'object') return;
    const to = socket.id === call.callerSocket ? call.calleeSocket : socket.id === call.calleeSocket ? call.callerSocket : null;
    if (to) toSocket(to, EV.callSignal, { callId: call.id, signal: data.signal });
  });

  socket.on('disconnect', () => {
    const id = callOfUser.get(uid);
    const call = id ? calls.get(id) : undefined;
    if (call && (call.callerSocket === socket.id || call.calleeSocket === socket.id)) endCall(call, 'failed');
  });
}

/** In a one-to-one call (ringing included). */
export const busyInCall = (userId: number) => callOfUser.has(userId);

/** tests */
export const activeCalls = () => calls.size;
