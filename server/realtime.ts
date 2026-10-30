import { EV } from '@timba/shared';
import type { Server } from 'socket.io';

let io: Server | null = null;
const online = new Map<number, number>();

export function setIo(server: Server | null) {
  io = server;
}

export const userRoom = (id: number) => `user:${id}`;
export const chatRoom = (id: number) => `chat:${id}`;

export function toUser(userId: number, event: string, data: unknown) {
  io?.to(userRoom(userId)).emit(event, data);
}

export function toSocket(socketId: string, event: string, data: unknown) {
  io?.to(socketId).emit(event, data);
}

/** Emit to every tab of a user but one. */
export function toUserExcept(userId: number, socketId: string, event: string, data: unknown) {
  io?.to(userRoom(userId)).except(socketId).emit(event, data);
}

export function toChat(chatId: number, event: string, data: unknown) {
  io?.to(chatRoom(chatId)).emit(event, data);
}

/** Emit to a chat room, skipping the sockets of one user (they get a personalized copy separately). */
export function toChatExcept(chatId: number, userId: number, event: string, data: unknown) {
  io?.to(chatRoom(chatId)).except(userRoom(userId)).emit(event, data);
}

export function toAll(event: string, data: unknown) {
  io?.emit(event, data);
}

/** Emit to everybody except the given users. */
export function toAllExcept(userIds: number[], event: string, data: unknown) {
  if (!userIds.length) return toAll(event, data);
  io?.except(userIds.map(userRoom)).emit(event, data);
}

export function joinChat(userId: number, chatId: number) {
  io?.in(userRoom(userId)).socketsJoin(chatRoom(chatId));
}

export function leaveChat(userId: number, chatId: number) {
  io?.in(userRoom(userId)).socketsLeave(chatRoom(chatId));
}

export function disconnectUser(userId: number) {
  io?.in(userRoom(userId)).disconnectSockets(true);
}

/** Throws every socket of a device out; the page shows the "banned" screen. */
export async function disconnectDevice(deviceId: string, payload: object) {
  if (!io) return;
  for (const s of await io.fetchSockets()) {
    if (s.data.deviceId === deviceId) {
      s.emit(EV.accountBanned, payload);
      s.disconnect(true);
    }
  }
}

/** Disconnect every socket except those belonging to the given user ids. */
export async function disconnectAllExcept(keep: Set<number>) {
  if (!io) return;
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if (!keep.has(s.data.userId as number)) s.disconnect(true);
  }
}

export function markOnline(userId: number): boolean {
  const n = online.get(userId) ?? 0;
  online.set(userId, n + 1);
  return n === 0;
}

export function markOffline(userId: number): boolean {
  const n = (online.get(userId) ?? 1) - 1;
  if (n <= 0) {
    online.delete(userId);
    return true;
  }
  online.set(userId, n);
  return false;
}

export const isOnline = (userId: number) => online.has(userId);

/** Sockets whose tab is currently visible — such users get in-app notifications instead of push. */
const activeSockets = new Map<number, Set<string>>();

export function setSocketActive(userId: number, socketId: string, active: boolean) {
  const set = activeSockets.get(userId) ?? new Set<string>();
  if (active) set.add(socketId);
  else set.delete(socketId);
  if (set.size) activeSockets.set(userId, set);
  else activeSockets.delete(userId);
}

export const isUserActive = (userId: number) => activeSockets.has(userId);
export const onlineCount = () => online.size;

export async function disconnectSessions(sessionIds: Set<string>, event: string) {
  if (!io) return;
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if (sessionIds.has(s.data.sessionId as string)) {
      s.emit(event, {});
      s.disconnect(true);
    }
  }
}
