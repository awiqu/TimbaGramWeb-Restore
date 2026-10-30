import type { ChecklistDTO, PollDTO } from '@timba/shared';
import { db } from '../db.js';
import { type ChatRow, getChat, getMember } from '../permissions.js';
import { type FileRow, type MessageRow, type UserRow, checklistsDTO, getMessageRow, getUserRow, isPremium, pollsDTO } from '../serialize.js';
import { BotApiError, badReq, forbiddenReq } from './errors.js';
import { nativeToEntities } from './format.js';
import { inlineToApi } from './markup.js';
import type { BotRow } from './store.js';

/**
 * Objects of the Bot API (User, Chat, Message, Poll…) built from the messenger's rows, in Telegram's shape.
 *
 * Ids: a message has the same id everywhere; a private chat's id is the id of the person on the other side
 * (as in Telegram, so `send_message(user_id, …)` works); a group or channel has the negative of its id.
 * A file's `file_id` is the id of the stored file.
 */

export interface ApiUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username: string;
  is_premium?: boolean;
}

export const apiUser = (u: UserRow): ApiUser => ({
  id: u.id,
  is_bot: !!u.is_bot,
  first_name: u.first_name || u.username,
  ...(u.last_name ? { last_name: u.last_name } : {}),
  username: u.username,
  ...(isPremium(u) ? { is_premium: true } : {}),
});

/** The person on the other side of a private chat (the bot itself in a chat with itself — never happens). */
function peerOf(chatId: number, botId: number): number {
  const r = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? LIMIT 1').get(chatId, botId) as
    | { user_id: number }
    | undefined;
  return r?.user_id ?? botId;
}

export const apiChatId = (chat: Pick<ChatRow, 'id' | 'type'>, botId: number) => (chat.type === 'private' ? peerOf(chat.id, botId) : -chat.id);

export interface ApiChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export function apiChat(chat: ChatRow, botId: number): ApiChat {
  if (chat.type === 'private') {
    const peer = getUserRow(peerOf(chat.id, botId));
    return {
      id: peer?.id ?? 0,
      type: 'private',
      ...(peer ? { first_name: peer.first_name || peer.username, ...(peer.last_name ? { last_name: peer.last_name } : {}), username: peer.username } : {}),
    };
  }
  return {
    id: -chat.id,
    type: chat.type === 'channel' ? 'channel' : chat.is_public ? 'supergroup' : 'group',
    title: chat.title,
    ...(chat.public_username ? { username: chat.public_username } : {}),
  };
}

/**
 * The chat a bot method talks about: an id (a person for a private chat, minus the chat's id for groups and
 * channels) or "@username" of a public group or channel.
 */
export function resolveChat(bot: BotRow, raw: unknown, opts: { member?: boolean } = {}): ChatRow {
  const member = opts.member !== false;
  let chat: ChatRow | undefined;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) raw = Number(raw.trim());
  if (typeof raw === 'string') {
    const name = raw.trim().replace(/^@/, '');
    if (!name) throw badReq('chat_id is empty');
    chat = db.prepare("SELECT * FROM chats WHERE public_username = ? AND type != 'private'").get(name) as ChatRow | undefined;
    if (!chat) throw badReq('chat not found');
  } else if (typeof raw === 'number' && Number.isInteger(raw) && raw !== 0) {
    if (raw > 0) {
      const target = getUserRow(raw);
      if (!target) throw badReq('chat not found');
      const key = [raw, bot.user_id].sort((a, b) => a - b).join(':');
      chat = db.prepare('SELECT * FROM chats WHERE private_key = ?').get(key) as ChatRow | undefined;
      // a bot cannot start a conversation: the person has to write to it first
      if (!chat || !getMember(chat.id, bot.user_id)) throw forbiddenReq("bot can't initiate conversation with a user");
    } else {
      chat = getChat(-raw);
      if (!chat || chat.type === 'private') throw badReq('chat not found');
    }
  } else {
    throw badReq('chat_id is empty');
  }
  if (member && !getMember(chat.id, bot.user_id)) {
    throw forbiddenReq(chat.type === 'channel' ? 'bot is not a member of the channel chat' : 'bot is not a member of the group chat');
  }
  return chat;
}

// ---------- files ----------

export interface ApiFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size: number;
}

const fileBase = (f: FileRow): ApiFileInfo => ({ file_id: f.id, file_unique_id: f.id, file_size: f.size });

/** One attachment as the Bot API's field of the message (photo, video, document, voice, video_note). */
function mediaField(f: FileRow): { field: string; value: unknown } {
  const base = fileBase(f);
  switch (f.kind) {
    case 'photo':
      return { field: 'photo', value: [{ ...base, width: f.width ?? 0, height: f.height ?? 0 }] };
    case 'video':
      return {
        field: 'video',
        value: { ...base, width: f.width ?? 0, height: f.height ?? 0, duration: Math.round(f.duration ?? 0), file_name: f.name, mime_type: f.mime },
      };
    case 'voice':
      return { field: 'voice', value: { ...base, duration: Math.round(f.duration ?? 0), mime_type: f.mime } };
    case 'round':
      return { field: 'video_note', value: { ...base, length: f.width ?? 240, duration: Math.round(f.duration ?? 0) } };
    default:
      return { field: 'document', value: { ...base, file_name: f.name, mime_type: f.mime } };
  }
}

// ---------- polls and checklists ----------

export interface ApiPoll {
  id: string;
  question: string;
  options: { text: string; voter_count: number }[];
  total_voter_count: number;
  is_closed: boolean;
  is_anonymous: boolean;
  type: 'regular' | 'quiz';
  allows_multiple_answers: boolean;
  correct_option_id?: number;
  explanation?: string;
  open_period?: number;
  close_date?: number;
}

/** The bot sees the right answer of its own quizzes, everybody else's only once they are closed. */
export function apiPoll(pollId: number, botId: number | null): ApiPoll | null {
  const row = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId) as
    | { id: number; creator_id: number | null; correct_option: number | null; explanation: string; close_at: number | null; created_at: number }
    | undefined;
  const p: PollDTO | undefined = pollsDTO([pollId]).get(pollId);
  if (!row || !p) return null;
  const mine = botId !== null && row.creator_id === botId;
  return {
    id: String(p.id),
    question: p.question,
    options: p.options.map((o) => ({ text: o.text, voter_count: o.voters })),
    total_voter_count: p.totalVoters,
    is_closed: p.closed,
    is_anonymous: p.anonymous,
    type: p.quiz ? 'quiz' : 'regular',
    allows_multiple_answers: p.multiple,
    ...(p.quiz && (mine || p.closed) && row.correct_option !== null ? { correct_option_id: row.correct_option } : {}),
    ...(p.quiz && (mine || p.closed) && row.explanation ? { explanation: row.explanation } : {}),
    ...(row.close_at ? { open_period: Math.round((row.close_at - row.created_at) / 1000), close_date: Math.floor(row.close_at / 1000) } : {}),
  };
}

export interface ApiChecklist {
  title: string;
  tasks: { id: number; text: string; completed_by_user?: ApiUser; completion_date?: number }[];
  others_can_add_tasks: boolean;
  others_can_mark_tasks_as_done: boolean;
}

export function apiChecklist(id: number): ApiChecklist | null {
  const c: ChecklistDTO | undefined = checklistsDTO([id]).get(id);
  if (!c) return null;
  const ids = c.items.map((i) => i.doneBy?.id).filter((x): x is number => !!x);
  const users = new Map(ids.map((u) => [u, getUserRow(u)]));
  return {
    title: c.title,
    tasks: c.items.map((i) => {
      const who = i.doneBy ? users.get(i.doneBy.id) : undefined;
      return {
        id: i.id,
        text: i.text,
        ...(who ? { completed_by_user: apiUser(who) } : {}),
        ...(i.doneAt ? { completion_date: Math.floor(i.doneAt / 1000) } : {}),
      };
    }),
    others_can_add_tasks: c.othersCanAdd,
    others_can_mark_tasks_as_done: true,
  };
}

// ---------- messages ----------

export type ApiMessage = Record<string, unknown> & { message_id: number; chat: ApiChat; date: number };

/** A message as the bot `botId` sees it. */
export function apiMessage(row: MessageRow, botId: number, opts: { shallow?: boolean } = {}): ApiMessage {
  const chat = getChat(row.chat_id);
  if (!chat) throw new BotApiError(400, 'Bad Request: chat not found');
  const sender = row.sender_id ? getUserRow(row.sender_id) : undefined;
  const channelPost = chat.type === 'channel' && row.thread_id === null;
  const m: ApiMessage = {
    message_id: row.id,
    ...(sender && !channelPost ? { from: apiUser(sender) } : {}),
    ...(channelPost ? { sender_chat: apiChat(chat, botId) } : {}),
    chat: apiChat(chat, botId),
    date: Math.floor(row.created_at / 1000),
    ...(row.edited_at ? { edit_date: Math.floor(row.edited_at / 1000) } : {}),
  };
  if (row.forwarded_from_name) {
    const origin = row.forwarded_from_id ? getUserRow(row.forwarded_from_id) : undefined;
    m.forward_origin = origin
      ? { type: 'user', sender_user: apiUser(origin), date: m.date }
      : { type: 'hidden_user', sender_user_name: row.forwarded_from_name, date: m.date };
    m.forward_date = m.date;
  }
  if (row.reply_to_id && !opts.shallow) {
    const rep = getMessageRow(row.reply_to_id);
    if (rep && rep.chat_id === row.chat_id) m.reply_to_message = apiMessage(rep, botId, { shallow: true });
  }

  const { text, entities } = nativeToEntities(row.text);
  const files = db
    .prepare('SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY mf.position')
    .all(row.id) as FileRow[];

  if (row.kind === 'service') {
    m.text = text;
  } else if (row.kind === 'poll' && row.poll_id) {
    m.poll = apiPoll(row.poll_id, botId);
  } else if (row.kind === 'checklist' && row.extra_id) {
    m.checklist = apiChecklist(row.extra_id);
  } else if (row.kind === 'sticker' && row.sticker) {
    const builtin = row.sticker.startsWith('tg:');
    m.sticker = {
      file_id: row.sticker,
      file_unique_id: row.sticker,
      type: 'regular',
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
      emoji: row.text,
      ...(builtin ? {} : row.extra_id ? { set_name: String(row.extra_id) } : {}),
    };
  } else if (files.length) {
    const first = mediaField(files[0]!);
    m[first.field] = first.value;
    // an album is one message here: the first picture has the usual field, all of them are listed in "attachments"
    if (files.length > 1) {
      m.media_group_id = String(row.id);
      m.attachments = files.map((f) => {
        const x = mediaField(f);
        return { type: x.field === 'document' ? 'document' : x.field, [x.field]: x.value };
      });
    }
    if (text) {
      m.caption = text;
      if (entities.length) m.caption_entities = entities;
    }
  } else {
    m.text = text;
    if (entities.length) m.entities = entities;
  }
  if (row.reply_markup) m.reply_markup = inlineToApi(JSON.parse(row.reply_markup));
  if (sender?.is_bot) {
    // an invoice the bot sent: the Message carries it, like Telegram's `invoice`
    const inv = db
      .prepare('SELECT id, title, description, amount, status FROM bot_invoices WHERE message_id = ?')
      .get(row.id) as { id: number; title: string; description: string; amount: number; status: string } | undefined;
    if (inv) m.invoice = { invoice_id: inv.id, title: inv.title, description: inv.description, currency: 'TK', total_amount: inv.amount, status: inv.status };
  }
  return m;
}

/** What ChatMember says about somebody in a chat: creator, administrator, member, kicked or left. */
export function apiChatMember(chat: ChatRow, user: UserRow) {
  const member = getMember(chat.id, user.id);
  if (!member) {
    const banned = db.prepare('SELECT 1 FROM chat_bans WHERE chat_id = ? AND user_id = ?').get(chat.id, user.id);
    return { status: banned ? 'kicked' : 'left', user: apiUser(user) };
  }
  if (member.role === 'owner') return { status: 'creator', user: apiUser(user), is_anonymous: false };
  if (member.role === 'admin') {
    const rights = JSON.parse(member.admin_rights || '{}') as Record<string, boolean>;
    return {
      status: 'administrator',
      user: apiUser(user),
      can_be_edited: false,
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: !!rights.deleteMessages,
      can_restrict_members: !!rights.banUsers,
      can_invite_users: !!rights.inviteUsers,
      can_pin_messages: !!rights.pinMessages,
      can_change_info: !!rights.changeInfo,
      can_promote_members: !!rights.addAdmins,
      can_post_messages: !!rights.postMessages,
      can_edit_messages: !!rights.editMessages,
      ...(member.custom_title ? { custom_title: member.custom_title } : {}),
    };
  }
  const muted = member.muted_until && member.muted_until > Date.now();
  return muted
    ? { status: 'restricted', user: apiUser(user), is_member: true, can_send_messages: false, until_date: Math.floor(member.muted_until! / 1000) }
    : { status: 'member', user: apiUser(user) };
}
