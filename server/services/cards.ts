import { CHECKLIST_MAX_ITEMS, EV } from '@timba/shared';
import { transfer } from '../bank/bank.js';
import { botHooks } from '../bots/hooks.js';
import { db, now } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { type ChatRow, assertSlowMode, getMember, membership, requireView, rightsOf } from '../permissions.js';
import { toChat } from '../realtime.js';
import { type MessageRow, type UserRow, getUserRow, messageDTO } from '../serialize.js';
import { txt } from '../strings.js';
import { assertNotBlocked, insertMessage, publishMessage } from './messages.js';

/**
 * Cards in messages: ТК sent right in a chat, fundraisers ("Скинуться") and checklists.
 * Each card is one message (kind + extra_id); when it changes the message is sent again as an edit.
 */

type CardKind = 'transfer' | 'fund' | 'checklist';

function requireWriter(chatId: number, user: UserRow): ChatRow {
  const chat = requireView(chatId, user);
  const me = membership(chat, user);
  if (!me.canSend) throw forbidden(me.mutedUntil ? txt.errors.cannotWriteMuted : txt.errors.cannotWrite);
  assertNotBlocked(chat, user);
  assertSlowMode(chat, user);
  return chat;
}

function postCard(chat: ChatRow, user: UserRow, kind: CardKind, extraId: number, text: string, clientId?: string, replyMarkup?: string | null) {
  const row = insertMessage(chat, user, { text, files: [], kind, extraId, replyMarkup });
  return publishMessage(chat, user, row, clientId);
}

/** Everybody sees the card's new state. */
function refreshCard(kind: CardKind, extraId: number) {
  const rows = db.prepare('SELECT * FROM messages WHERE kind = ? AND extra_id = ?').all(kind, extraId) as MessageRow[];
  for (const r of rows) toChat(r.chat_id, EV.messageEdit, messageDTO(r));
}

/** Everybody sees the checklist as it is now (a bot edited it). */
export const refreshChecklist = (id: number) => refreshCard('checklist', id);

function cardMessage(kind: CardKind, extraId: number): MessageRow {
  const r = db.prepare('SELECT * FROM messages WHERE kind = ? AND extra_id = ? ORDER BY id LIMIT 1').get(kind, extraId) as
    | MessageRow
    | undefined;
  if (!r) throw notFound(txt.errors.messageNotFound);
  return r;
}

// ---------- ТК transfer in a chat ----------

export function sendChatTransfer(
  chatId: number,
  user: UserRow,
  input: { toUserId: number; amount: number; comment: string; clientId?: string },
) {
  const chat = requireWriter(chatId, user);
  const to = getUserRow(input.toUserId);
  if (!to || !getMember(chat.id, to.id)) throw notFound(txt.errors.memberNotFound);
  if (to.is_bot) throw badRequest(txt.bots.noTransfers);
  // balance, freezes and self-transfers are checked by the bank
  transfer(user, to, input.amount, input.comment);
  const res = db
    .prepare('INSERT INTO chat_transfers (from_id, to_id, amount, created_at) VALUES (?, ?, ?, ?)')
    .run(user.id, to.id, input.amount, now());
  return postCard(chat, user, 'transfer', Number(res.lastInsertRowid), input.comment, input.clientId);
}

// ---------- fundraisers ----------

interface FundRow {
  id: number;
  chat_id: number;
  creator_id: number | null;
  title: string;
  goal: number | null;
  collected: number;
  closed: number;
}

const getFund = (id: number) => db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as FundRow | undefined;

export function createFund(chatId: number, user: UserRow, input: { title: string; goal: number | null; clientId?: string }) {
  const chat = requireWriter(chatId, user);
  if (chat.type !== 'group') throw badRequest(txt.errors.groupsOnly);
  const res = db
    .prepare('INSERT INTO funds (chat_id, creator_id, title, goal, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(chat.id, user.id, input.title, input.goal, now());
  return postCard(chat, user, 'fund', Number(res.lastInsertRowid), '', input.clientId);
}

/** Chip in: the coins go straight to the organiser. */
export function contributeToFund(fundId: number, user: UserRow, amount: number) {
  const fund = getFund(fundId);
  if (!fund) throw notFound(txt.errors.fundNotFound);
  requireView(fund.chat_id, user);
  if (!getMember(fund.chat_id, user.id)) throw forbidden(txt.errors.notMember);
  if (fund.closed) throw badRequest(txt.errors.fundClosed);
  const creator = fund.creator_id ? getUserRow(fund.creator_id) : undefined;
  if (!creator) throw badRequest(txt.errors.fundClosed);
  const res = transfer(user, creator, amount, txt.labels.fundTransfer(fund.title));
  db.transaction(() => {
    db.prepare('INSERT INTO fund_contributions (fund_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)').run(fund.id, user.id, amount, now());
    db.prepare('UPDATE funds SET collected = collected + ? WHERE id = ?').run(amount, fund.id);
  })();
  refreshCard('fund', fund.id);
  return { balance: res.balance, message: messageDTO(cardMessage('fund', fund.id), user.id) };
}

export function closeFund(fundId: number, user: UserRow) {
  const fund = getFund(fundId);
  if (!fund) throw notFound(txt.errors.fundNotFound);
  const chat = requireView(fund.chat_id, user);
  const allowed = fund.creator_id === user.id || rightsOf(user, chat, getMember(chat.id, user.id)).deleteMessages;
  if (!allowed) throw forbidden();
  if (!fund.closed) {
    db.prepare('UPDATE funds SET closed = 1 WHERE id = ?').run(fund.id);
    refreshCard('fund', fund.id);
  }
  return messageDTO(cardMessage('fund', fund.id), user.id);
}

// ---------- checklists ----------

interface ChecklistRow {
  id: number;
  chat_id: number;
  creator_id: number | null;
  title: string;
  others_can_add: number;
}

const getChecklist = (id: number) => db.prepare('SELECT * FROM checklists WHERE id = ?').get(id) as ChecklistRow | undefined;

export function createChecklist(
  chatId: number,
  user: UserRow,
  input: { title: string; items: string[]; othersCanAdd: boolean; clientId?: string; replyMarkup?: string | null },
) {
  const chat = requireWriter(chatId, user);
  const id = db.transaction(() => {
    const res = db
      .prepare('INSERT INTO checklists (chat_id, creator_id, title, others_can_add, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(chat.id, user.id, input.title, input.othersCanAdd ? 1 : 0, now());
    const cid = Number(res.lastInsertRowid);
    const ins = db.prepare('INSERT INTO checklist_items (checklist_id, position, text, added_by) VALUES (?, ?, ?, ?)');
    input.items.forEach((text, i) => ins.run(cid, i, text, user.id));
    return cid;
  })();
  return postCard(chat, user, 'checklist', id, '', input.clientId, input.replyMarkup);
}

/** Members tick items off (or back on); the list shows who did it. */
function requireChecklistMember(checklistId: number, user: UserRow) {
  const list = getChecklist(checklistId);
  if (!list) throw notFound(txt.errors.checklistNotFound);
  const chat = requireView(list.chat_id, user);
  if (!getMember(chat.id, user.id)) throw forbidden(txt.errors.notMember);
  return { list, chat };
}

export function toggleChecklistItem(checklistId: number, itemId: number, user: UserRow) {
  const { list } = requireChecklistMember(checklistId, user);
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ? AND checklist_id = ?').get(itemId, list.id) as
    | { id: number; done_by: number | null }
    | undefined;
  if (!item) throw notFound(txt.errors.checklistNotFound);
  if (item.done_by) db.prepare('UPDATE checklist_items SET done_by = NULL, done_at = NULL WHERE id = ?').run(item.id);
  else db.prepare('UPDATE checklist_items SET done_by = ?, done_at = ? WHERE id = ?').run(user.id, now(), item.id);
  refreshCard('checklist', list.id);
  botHooks.checklistChanged(list.id, user, item.done_by ? { done: [], undone: [item.id], added: [] } : { done: [item.id], undone: [], added: [] });
  return messageDTO(cardMessage('checklist', list.id), user.id);
}

export function addChecklistItem(checklistId: number, user: UserRow, text: string) {
  const { list, chat } = requireChecklistMember(checklistId, user);
  if (!list.others_can_add && list.creator_id !== user.id) throw forbidden(txt.errors.checklistLocked);
  if (!membership(chat, user).canSend) throw forbidden(txt.errors.cannotWrite);
  const count = (db.prepare('SELECT COUNT(*) c, COALESCE(MAX(position), -1) p FROM checklist_items WHERE checklist_id = ?').get(list.id) as {
    c: number;
    p: number;
  });
  if (count.c >= CHECKLIST_MAX_ITEMS) throw badRequest(txt.errors.checklistFull);
  const added = db.prepare('INSERT INTO checklist_items (checklist_id, position, text, added_by) VALUES (?, ?, ?, ?)').run(list.id, count.p + 1, text, user.id);
  refreshCard('checklist', list.id);
  botHooks.checklistChanged(list.id, user, { done: [], undone: [], added: [Number(added.lastInsertRowid)] });
  return messageDTO(cardMessage('checklist', list.id), user.id);
}
