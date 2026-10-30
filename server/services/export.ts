import { stripFormatting } from '@timba/shared';
import type { MessageDTO, UserDTO } from '@timba/shared';
import { db } from '../db.js';
import { requireView } from '../permissions.js';
import { type MessageRow, type UserRow, messagesDTO } from '../serialize.js';
import { txt } from '../strings.js';
import { chatDTO } from './chats.js';

/** Export stops here, so one request cannot read the whole database. */
export const EXPORT_MAX_MESSAGES = 20_000;
const PAGE = 500;

/** One line of the text: what the message holds, without the formatting marks. */
function body(m: MessageDTO): string {
  if (m.poll) return txt.labels.pollPreview(m.poll.question);
  if (m.transfer) return txt.labels.transferPreview(m.transfer.amount);
  if (m.fund) return txt.labels.fundPreview(m.fund.title);
  if (m.checklist) return txt.labels.checklistPreview(m.checklist.title);
  if (m.sticker) return txt.labels.sticker(m.sticker.emoji);
  const parts: string[] = [];
  for (const a of m.attachments) {
    parts.push(
      a.kind === 'voice' ? txt.labels.voice : a.kind === 'round' ? txt.labels.round : a.kind === 'photo' ? txt.labels.photo : a.kind === 'video' ? txt.labels.video : a.name,
    );
  }
  if (m.text) parts.push(stripFormatting(m.text));
  return parts.join('\n');
}

const senderName = (u: UserDTO) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-01 14:03" in the viewer's time zone (tzOffset = Date.getTimezoneOffset()). */
export function exportTime(ts: number, tzOffset: number): string {
  const d = new Date(ts - tzOffset * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The chat history as plain text, oldest message first: "[date time] Name: text".
 * Hidden messages (cleared by the viewer) are left out; comments under channel posts are not included.
 */
export function exportChat(chatId: number, viewer: UserRow, tzOffset: number): { title: string; text: string; count: number } {
  const chat = requireView(chatId, viewer);
  const title = chatDTO(chat, viewer).title || txt.labels.savedMessages;
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND thread_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = messages.id AND h.user_id = ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, viewer.id, EXPORT_MAX_MESSAGES) as MessageRow[];
  rows.reverse();

  const lines: string[] = [txt.export.header(title, exportTime(Date.now(), tzOffset), rows.length), ''];
  for (let i = 0; i < rows.length; i += PAGE) {
    for (const m of messagesDTO(rows.slice(i, i + PAGE), viewer.id)) {
      const who =
        m.kind === 'service' ? '' : m.sender ? `${senderName(m.sender)}: ` : m.signature ? `${m.signature}: ` : chat.type === 'channel' ? `${title}: ` : '';
      const reply = m.replyTo ? `${txt.export.replyTo(stripFormatting(m.replyTo.text).replace(/\s+/g, ' ').slice(0, 80))} ` : '';
      const text = `${reply}${body(m)}${m.editedAt ? ` ${txt.export.edited}` : ''}`.replace(/\n/g, '\n    ');
      lines.push(`[${exportTime(m.createdAt, tzOffset)}] ${who}${text}`);
    }
  }
  return { title, text: `${lines.join('\n')}\n`, count: rows.length };
}
