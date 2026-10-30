import type {
  ChatTransferDTO,
  ChecklistDTO,
  FundDTO,
  FileDTO,
  InlineKeyboardDTO,
  FileKind,
  LastSeenApprox,
  MessageDTO,
  MessageKind,
  PollDTO,
  Privacy,
  ReactionDTO,
  StickerDTO,
  UserDTO,
} from '@timba/shared';
import { ADMIN_USERNAME, BUILTIN_STICKER_PREFIX, stripFormatting } from '@timba/shared';
import { db } from './db.js';
import { badgeOf } from './profile.js';
import { isOnline } from './realtime.js';
import { txt } from './strings.js';

export interface UserRow {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  bio: string;
  avatar_file_id: string | null;
  password_hash: string;
  is_banned: number;
  ban_reason: string;
  prefs: string;
  privacy: string;
  created_at: number;
  last_seen_at: number | null;
  phone: string | null;
  premium_until: number | null;
  badge_id: number | null;
  /** a bot made by a person (see bots/) */
  is_bot: number;
}

export interface FileRow {
  id: string;
  uploader_id: number | null;
  kind: FileKind;
  path: string;
  thumb_path: string | null;
  mime: string;
  size: number;
  name: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: string | null;
  transcript: string | null;
  created_at: number;
}

export interface MessageRow {
  id: number;
  chat_id: number;
  sender_id: number | null;
  kind: MessageKind;
  text: string;
  reply_to_id: number | null;
  forwarded_from_id: number | null;
  forwarded_from_name: string | null;
  signature: string | null;
  poll_id: number | null;
  thread_id: number | null;
  edited_at: number | null;
  created_at: number;
  silent: number;
  expires_at: number | null;
  /** transfer / fund / checklist id for those kinds; the pack of a custom sticker */
  extra_id: number | null;
  /** kind "sticker": "tg:<key>" or the image's file id */
  sticker: string | null;
  /** a bot's inline keyboard under the message: JSON of InlineKeyboardDTO */
  reply_markup: string | null;
}

export interface PollRow {
  id: number;
  creator_id: number | null;
  question: string;
  /** JSON string[] */
  options: string;
  anonymous: number;
  multiple: number;
  quiz: number;
  correct_option: number | null;
  explanation: string;
  closed: number;
  close_at: number | null;
  created_at: number;
}

export const DEFAULT_PRIVACY: Privacy = { lastSeen: 'everybody', avatar: 'everybody', groupInvites: 'everybody', phone: 'nobody' };

/** The number as `viewerId` may see it: the owner and the global admin always, others by privacy. */
export function visiblePhone(r: UserRow, viewer: UserRow): string | null {
  if (!r.phone) return null;
  if (r.id === viewer.id || viewer.username.toLowerCase() === ADMIN_USERNAME) return r.phone;
  return parsePrivacy(r).phone === 'everybody' && !isBlockedBy(r.id, viewer.id) ? r.phone : null;
}

export function parsePrivacy(r: Pick<UserRow, 'privacy'>): Privacy {
  return { ...DEFAULT_PRIVACY, ...JSON.parse(r.privacy || '{}') };
}

/** "last seen recently" & co. for users who hide the exact time (like Telegram) */
export function lastSeenApprox(online: boolean, lastSeenAt: number | null): LastSeenApprox {
  if (online) return 'recently';
  if (!lastSeenAt) return 'long';
  const days = (Date.now() - lastSeenAt) / 86400_000;
  if (days < 3) return 'recently';
  if (days < 7) return 'week';
  if (days < 30) return 'month';
  return 'long';
}

/**
 * Public view of a user. Applies the owner's privacy settings unless `self` is set;
 * `blocked` (the owner blocked the viewer) hides the avatar and last seen, too.
 */
export function userDTO(r: UserRow, opts: { self?: boolean; blocked?: boolean } = {}): UserDTO {
  const privacy = parsePrivacy(r);
  const online = isOnline(r.id);
  const hideSeen = !opts.self && (privacy.lastSeen === 'nobody' || !!opts.blocked);
  const hideAvatar = !opts.self && (privacy.avatar === 'nobody' || !!opts.blocked);
  return {
    id: r.id,
    username: r.username,
    firstName: r.first_name,
    lastName: r.last_name,
    bio: r.bio,
    avatarFileId: hideAvatar ? null : r.avatar_file_id,
    lastSeenAt: hideSeen ? null : r.last_seen_at,
    online: hideSeen ? false : online,
    lastSeenApprox: hideSeen ? (opts.blocked ? 'long' : lastSeenApprox(online, r.last_seen_at ?? r.created_at)) : null,
    premium: isPremium(r),
    badge: badgeOf(r.badge_id),
    // a bot has no last seen: the app shows «бот» instead
    ...(r.is_bot ? { isBot: true, online: false, lastSeenAt: null, lastSeenApprox: null } : {}),
  };
}

export const isPremium = (r: Pick<UserRow, 'premium_until'>) => !!r.premium_until && r.premium_until > Date.now();

/** Did `ownerId` block `viewerId`? */
export function isBlockedBy(ownerId: number, viewerId: number): boolean {
  return !!db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND blocked_id = ?').get(ownerId, viewerId);
}

/** May `actor` add `target` to a group? (privacy "groupInvites" and blocks; the global admin always may) */
export function canInviteUser(actor: UserRow, target: UserRow): boolean {
  // a bot's owner decides whether it may be added to groups (even the admin cannot override that)
  if (target.is_bot) return !!db.prepare('SELECT 1 FROM bots WHERE user_id = ? AND can_join_groups = 1').get(target.id);
  if (actor.username.toLowerCase() === ADMIN_USERNAME) return true;
  if (isBlockedBy(target.id, actor.id)) return false;
  return parsePrivacy(target).groupInvites !== 'nobody';
}

export function blockedIdsOf(userId: number): number[] {
  return (db.prepare('SELECT blocked_id FROM user_blocks WHERE user_id = ?').all(userId) as { blocked_id: number }[]).map(
    (r) => r.blocked_id,
  );
}

/** userDTO as seen by a specific viewer (blocks + privacy). */
export function userDTOFor(r: UserRow, viewerId: number): UserDTO {
  if (r.id === viewerId) return userDTO(r, { self: true });
  return userDTO(r, { blocked: isBlockedBy(r.id, viewerId) });
}

export function displayName(r: Pick<UserRow, 'first_name' | 'last_name' | 'username'>): string {
  const n = `${r.first_name} ${r.last_name}`.trim();
  return n || `@${r.username}`;
}

export function getUserRow(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function usersByIds(ids: Iterable<number>): Map<number, UserRow> {
  const list = [...new Set(ids)];
  const out = new Map<number, UserRow>();
  if (!list.length) return out;
  const rows = db
    .prepare(`SELECT * FROM users WHERE id IN (${list.map(() => '?').join(',')})`)
    .all(...list) as UserRow[];
  for (const r of rows) out.set(r.id, r);
  return out;
}

export function fileDTO(r: FileRow): FileDTO {
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    size: r.size,
    name: r.name,
    width: r.width,
    height: r.height,
    duration: r.duration,
    hasThumb: !!r.thumb_path,
    waveform: r.waveform ? (JSON.parse(r.waveform) as number[]) : null,
    ...(r.transcript ? { transcript: r.transcript } : {}),
  };
}

export function getMessageRow(id: number): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
}

const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');

/**
 * Poll DTOs. With a viewer, includes their votes and (for a quiz they answered) the correct option.
 * Without one (broadcasts) only public data is included.
 */
export function pollsDTO(pollIds: number[], viewerId?: number): Map<number, PollDTO> {
  const out = new Map<number, PollDTO>();
  const ids = [...new Set(pollIds)];
  if (!ids.length) return out;
  const polls = db.prepare(`SELECT * FROM polls WHERE id IN (${ph(ids.length)})`).all(...ids) as PollRow[];
  const counts = db
    .prepare(
      `SELECT poll_id, option_idx, COUNT(*) c FROM poll_votes WHERE poll_id IN (${ph(ids.length)})
       GROUP BY poll_id, option_idx`,
    )
    .all(...ids) as { poll_id: number; option_idx: number; c: number }[];
  const voters = db
    .prepare(
      `SELECT poll_id, COUNT(DISTINCT user_id) c FROM poll_votes WHERE poll_id IN (${ph(ids.length)}) GROUP BY poll_id`,
    )
    .all(...ids) as { poll_id: number; c: number }[];
  const mine =
    viewerId === undefined
      ? []
      : (db
          .prepare(`SELECT poll_id, option_idx FROM poll_votes WHERE user_id = ? AND poll_id IN (${ph(ids.length)})`)
          .all(viewerId, ...ids) as { poll_id: number; option_idx: number }[]);

  for (const p of polls) {
    const texts = JSON.parse(p.options) as string[];
    const options = texts.map((text, i) => ({
      text,
      voters: counts.find((c) => c.poll_id === p.id && c.option_idx === i)?.c ?? 0,
    }));
    const dto: PollDTO = {
      id: p.id,
      question: p.question,
      options,
      totalVoters: voters.find((v) => v.poll_id === p.id)?.c ?? 0,
      anonymous: !!p.anonymous,
      multiple: !!p.multiple,
      quiz: !!p.quiz,
      closed: !!p.closed,
      closeAt: p.close_at,
    };
    if (viewerId !== undefined) {
      dto.myVotes = mine.filter((m) => m.poll_id === p.id).map((m) => m.option_idx).sort((a, b) => a - b);
    }
    if (p.quiz && (p.closed || (dto.myVotes?.length ?? 0) > 0)) {
      dto.correctOption = p.correct_option;
      dto.explanation = p.explanation;
    }
    out.set(p.id, dto);
  }
  return out;
}

/**
 * Serialize messages.
 *
 * `viewerId` personalizes the result (own poll votes; in channels the author sees themself as the sender).
 * Without it the DTO is safe to broadcast to everybody in the chat.
 */
/** The answered message as one line over a reply: no markers, spoilers hidden, only as long as the bar can show. */
function replyQuote(text: string): string {
  const line = stripFormatting(text).replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export function messagesDTO(rows: MessageRow[], viewerId?: number): MessageDTO[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const attRows = db
    .prepare(
      `SELECT mf.message_id, f.* FROM message_files mf JOIN files f ON f.id = mf.file_id
       WHERE mf.message_id IN (${ph(ids.length)}) ORDER BY mf.position`,
    )
    .all(...ids) as (FileRow & { message_id: number })[];
  const atts = new Map<number, FileDTO[]>();
  for (const a of attRows) {
    const list = atts.get(a.message_id) ?? [];
    list.push(fileDTO(a));
    atts.set(a.message_id, list);
  }

  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is number => !!x))];
  const replies = new Map<number, MessageRow>();
  if (replyIds.length) {
    const rr = db.prepare(`SELECT * FROM messages WHERE id IN (${ph(replyIds.length)})`).all(...replyIds) as MessageRow[];
    for (const r of rr) replies.set(r.id, r);
  }
  // the files of the answered messages: what kind they are (for the quote's text) and the first picture (shown small)
  const replyMedia = new Map<number, string>();
  const replyThumb = new Map<number, { fileId: string; hasThumb: boolean }>();
  if (replies.size) {
    const files = db
      .prepare(
        `SELECT mf.message_id, f.* FROM message_files mf JOIN files f ON f.id = mf.file_id
         WHERE mf.message_id IN (${ph(replies.size)}) ORDER BY mf.position`,
      )
      .all(...replies.keys()) as (FileRow & { message_id: number })[];
    const kinds = new Map<number, string[]>();
    for (const f of files) {
      kinds.set(f.message_id, [...(kinds.get(f.message_id) ?? []), f.kind]);
      if (replyThumb.has(f.message_id) || (f.kind !== 'photo' && f.kind !== 'video')) continue;
      const dto = fileDTO(f);
      if (dto.kind === 'photo' || dto.hasThumb) replyThumb.set(f.message_id, { fileId: dto.id, hasThumb: !!dto.hasThumb });
    }
    for (const [id, list] of kinds) {
      const only = (k: string) => list.every((x) => x === k);
      replyMedia.set(
        id,
        list[0] === 'voice' ? txt.labels.voice : list[0] === 'round' ? txt.labels.round : only('photo') ? txt.labels.photo : only('video') ? txt.labels.video : txt.labels.media,
      );
    }
  }

  // chats involved (channel posts hide their author)
  const chatIds = [...new Set([...rows.map((r) => r.chat_id), ...[...replies.values()].map((r) => r.chat_id)])];
  const chats = new Map(
    (
      db
        .prepare(`SELECT id, type, title, comments_enabled FROM chats WHERE id IN (${ph(chatIds.length)})`)
        .all(...chatIds) as {
        id: number;
        type: string;
        title: string;
        comments_enabled: number;
      }[]
    ).map((c) => [c.id, c]),
  );
  const isChannelMsg = (r: MessageRow) => chats.get(r.chat_id)?.type === 'channel';
  /** a channel post (not a comment under it) */
  const isPost = (r: MessageRow) => isChannelMsg(r) && r.thread_id === null;

  // channel views: members that have read up to the post (always at least 1 — the author)
  const views = new Map<number, number>();
  for (const chatId of new Set(rows.filter(isPost).map((r) => r.chat_id))) {
    const reads = (
      db.prepare('SELECT last_read_id FROM chat_members WHERE chat_id = ?').all(chatId) as { last_read_id: number }[]
    ).map((m) => m.last_read_id);
    for (const r of rows) {
      if (r.chat_id === chatId) views.set(r.id, Math.max(1, reads.filter((x) => x >= r.id).length));
    }
  }

  const pollIds = [...rows.map((r) => r.poll_id), ...[...replies.values()].map((r) => r.poll_id)].filter(
    (x): x is number => x != null,
  );
  const polls = pollsDTO(pollIds, viewerId);

  // reactions, grouped by emoji, most popular first
  const reactRows = db
    .prepare(
      `SELECT message_id, user_id, emoji, created_at FROM message_reactions WHERE message_id IN (${ph(ids.length)})
       ORDER BY created_at DESC`,
    )
    .all(...ids) as { message_id: number; user_id: number; emoji: string; created_at: number }[];

  // comments under channel posts
  const postIds = rows.filter((r) => isPost(r) && r.kind !== 'service' && chats.get(r.chat_id)?.comments_enabled).map((r) => r.id);
  const commentCounts = new Map<number, number>();
  const commenterIds = new Map<number, number[]>();
  if (postIds.length) {
    const cc = db
      .prepare(`SELECT thread_id, COUNT(*) c FROM messages WHERE thread_id IN (${ph(postIds.length)}) GROUP BY thread_id`)
      .all(...postIds) as { thread_id: number; c: number }[];
    for (const c of cc) commentCounts.set(c.thread_id, c.c);
    const recent = db
      .prepare(
        `SELECT thread_id, sender_id FROM messages WHERE thread_id IN (${ph(postIds.length)}) AND sender_id IS NOT NULL
         GROUP BY thread_id, sender_id ORDER BY MAX(id) DESC`,
      )
      .all(...postIds) as { thread_id: number; sender_id: number }[];
    for (const r of recent) {
      const list = commenterIds.get(r.thread_id) ?? [];
      if (list.length < 3) list.push(r.sender_id);
      commenterIds.set(r.thread_id, list);
    }
  }

  const users = usersByIds(
    [
      ...rows.map((r) => r.sender_id),
      ...[...replies.values()].map((r) => r.sender_id),
      ...reactRows.map((r) => r.user_id),
      ...[...commenterIds.values()].flat(),
    ].filter((x): x is number => x != null),
  );

  const reactionsOf = (r: MessageRow): ReactionDTO[] => {
    const list = reactRows.filter((x) => x.message_id === r.id);
    if (!list.length) return [];
    const anonymous = isPost(r);
    const by = new Map<string, ReactionDTO & { first: number }>();
    for (const x of list) {
      const cur = by.get(x.emoji) ?? { emoji: x.emoji, count: 0, recent: [], first: x.created_at };
      cur.count++;
      cur.first = Math.min(cur.first, x.created_at);
      if (!anonymous && cur.recent.length < 3 && users.has(x.user_id)) cur.recent.push(userDTO(users.get(x.user_id)!));
      if (viewerId !== undefined) cur.mine = cur.mine || x.user_id === viewerId;
      by.set(x.emoji, cur);
    }
    return [...by.values()]
      .sort((a, b) => b.count - a.count || a.first - b.first)
      .map(({ first: _f, ...rest }) => (viewerId === undefined ? rest : { ...rest, mine: !!rest.mine }));
  };

  // cards: ТК transfers, fundraisers, checklists
  const extraIds = (kind: string) => rows.filter((r) => r.kind === kind && r.extra_id).map((r) => r.extra_id!);
  const transfers = transfersDTO(extraIds('transfer'));
  const funds = fundsDTO(extraIds('fund'));
  const checklists = checklistsDTO(extraIds('checklist'));
  const livePacks = existingPacks(extraIds('sticker'));

  return rows.map((r) => {
    let replyTo: MessageDTO['replyTo'] = null;
    if (r.reply_to_id) {
      const rep = replies.get(r.reply_to_id);
      if (rep) {
        const su = rep.sender_id ? users.get(rep.sender_id) : undefined;
        const pollQ = rep.poll_id ? polls.get(rep.poll_id)?.question : undefined;
        const repIsPost = isChannelMsg(rep) && rep.thread_id === null;
        replyTo = {
          id: rep.id,
          senderId: repIsPost ? null : rep.sender_id,
          senderName: repIsPost
            ? (chats.get(rep.chat_id)?.title ?? '')
            : su
              ? displayName(su)
              : txt.labels.deletedAccount,
          text: rep.kind === 'sticker' ? txt.labels.sticker(rep.text) : replyQuote(rep.text) || (pollQ ? txt.labels.pollPreview(pollQ) : (replyMedia.get(rep.id) ?? '')),
          kind: rep.kind,
          deleted: false,
          thumb: replyThumb.get(rep.id) ?? null,
        };
      } else {
        replyTo = {
          id: r.reply_to_id,
          senderId: null,
          senderName: '',
          text: txt.labels.deletedMessage,
          kind: 'text',
          deleted: true,
        };
      }
    }
    // channel posts hide the admin who wrote them; comments show their authors
    const hidden = isChannelMsg(r) && r.thread_id === null;
    const post = hidden && r.kind !== 'service';
    const showSender = !hidden || (viewerId !== undefined && r.sender_id === viewerId);
    const sender = showSender && r.sender_id ? users.get(r.sender_id) : undefined;
    return {
      id: r.id,
      chatId: r.chat_id,
      senderId: showSender ? r.sender_id : null,
      sender: sender ? userDTO(sender) : null,
      kind: r.kind,
      text: r.text,
      replyTo,
      forwardedFrom: r.forwarded_from_name ? { id: r.forwarded_from_id, name: r.forwarded_from_name } : null,
      attachments: atts.get(r.id) ?? [],
      poll: r.poll_id ? (polls.get(r.poll_id) ?? null) : null,
      signature: post ? r.signature : null,
      views: post ? (views.get(r.id) ?? 1) : null,
      reactions: reactionsOf(r),
      threadId: r.thread_id,
      commentCount: postIds.includes(r.id) ? (commentCounts.get(r.id) ?? 0) : null,
      commenters: (commenterIds.get(r.id) ?? []).filter((id) => users.has(id)).map((id) => userDTO(users.get(id)!)),
      editedAt: r.edited_at,
      createdAt: r.created_at,
      ...(r.silent ? { silent: true } : {}),
      ...(r.kind === 'transfer' && r.extra_id && transfers.has(r.extra_id) ? { transfer: transfers.get(r.extra_id) } : {}),
      ...(r.kind === 'fund' && r.extra_id && funds.has(r.extra_id) ? { fund: funds.get(r.extra_id) } : {}),
      ...(r.kind === 'checklist' && r.extra_id && checklists.has(r.extra_id) ? { checklist: checklists.get(r.extra_id) } : {}),
      ...(r.kind === 'sticker' && r.sticker ? { sticker: messageSticker(r, livePacks) } : {}),
      ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
      ...(r.reply_markup ? { replyMarkup: JSON.parse(r.reply_markup) as InlineKeyboardDTO } : {}),
    };
  });
}

export function messageDTO(r: MessageRow, viewerId?: number): MessageDTO {
  return messagesDTO([r], viewerId)[0]!;
}

// ---------- cards in messages ----------

function transfersDTO(ids: number[]): Map<number, ChatTransferDTO> {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT * FROM chat_transfers WHERE id IN (${ph(ids.length)})`).all(...ids) as {
    id: number;
    from_id: number | null;
    to_id: number | null;
    amount: number;
  }[];
  const users = usersByIds(rows.flatMap((r) => [r.from_id, r.to_id]).filter((x): x is number => x !== null));
  const u = (id: number | null) => (id && users.has(id) ? userDTO(users.get(id)!) : null);
  return new Map(rows.map((r) => [r.id, { amount: r.amount, from: u(r.from_id), to: u(r.to_id) }]));
}

export function fundsDTO(ids: number[]): Map<number, FundDTO> {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT * FROM funds WHERE id IN (${ph(ids.length)})`).all(...ids) as {
    id: number;
    title: string;
    goal: number | null;
    collected: number;
    closed: number;
    creator_id: number | null;
  }[];
  const contrib = db
    .prepare(
      `SELECT fund_id, user_id, SUM(amount) amount, MAX(id) last FROM fund_contributions WHERE fund_id IN (${ph(ids.length)})
       GROUP BY fund_id, user_id ORDER BY last DESC`,
    )
    .all(...ids) as { fund_id: number; user_id: number | null; amount: number }[];
  const users = usersByIds(contrib.map((c) => c.user_id).filter((x): x is number => x !== null));
  return new Map(
    rows.map((r) => {
      const mine = contrib.filter((c) => c.fund_id === r.id);
      return [
        r.id,
        {
          id: r.id,
          title: r.title,
          goal: r.goal,
          collected: r.collected,
          contributors: mine.length,
          closed: !!r.closed,
          creatorId: r.creator_id,
          recent: mine
            .filter((c) => c.user_id !== null && users.has(c.user_id))
            .slice(0, 3)
            .map((c) => ({ user: userDTO(users.get(c.user_id!)!), amount: c.amount })),
        },
      ];
    }),
  );
}

export function checklistsDTO(ids: number[]): Map<number, ChecklistDTO> {
  if (!ids.length) return new Map();
  const lists = db.prepare(`SELECT * FROM checklists WHERE id IN (${ph(ids.length)})`).all(...ids) as {
    id: number;
    title: string;
    creator_id: number | null;
    others_can_add: number;
  }[];
  const items = db
    .prepare(`SELECT * FROM checklist_items WHERE checklist_id IN (${ph(ids.length)}) ORDER BY position, id`)
    .all(...ids) as { id: number; checklist_id: number; text: string; done_by: number | null; done_at: number | null }[];
  const users = usersByIds(items.map((i) => i.done_by).filter((x): x is number => x !== null));
  return new Map(
    lists.map((l) => [
      l.id,
      {
        id: l.id,
        title: l.title,
        creatorId: l.creator_id,
        othersCanAdd: !!l.others_can_add,
        items: items
          .filter((i) => i.checklist_id === l.id)
          .map((i) => ({
            id: i.id,
            text: i.text,
            doneBy: i.done_by && users.has(i.done_by) ? userDTO(users.get(i.done_by)!) : null,
            doneAt: i.done_at,
          })),
      },
    ]),
  );
}

// ---------- stickers ----------

function existingPacks(ids: number[]): Set<number> {
  if (!ids.length) return new Set();
  const uniq = [...new Set(ids)];
  return new Set(
    (db.prepare(`SELECT id FROM sticker_packs WHERE id IN (${ph(uniq.length)})`).all(...uniq) as { id: number }[]).map((r) => r.id),
  );
}

/** The sticker of a message; its pack is only offered while it still exists. */
function messageSticker(r: MessageRow, livePacks: Set<number>): StickerDTO {
  const builtin = r.sticker!.startsWith(BUILTIN_STICKER_PREFIX);
  return {
    id: builtin ? r.sticker! : `f:${r.sticker}`,
    fileId: builtin ? null : r.sticker,
    emoji: r.text,
    packId: r.extra_id && livePacks.has(r.extra_id) ? r.extra_id : null,
  };
}
