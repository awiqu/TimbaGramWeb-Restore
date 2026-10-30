import { HASHTAG_RE } from '@timba/shared';
import Database from 'better-sqlite3';
import { encryptExisting, installDecryption } from './crypt.js';

export type DB = Database.Database;

export let db: DB;

const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    avatar_file_id TEXT,
    password_hash TEXT NOT NULL,
    is_banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT NOT NULL DEFAULT '',
    prefs TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    thumb_path TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    name TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    private_key TEXT UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    avatar_file_id TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    public_username TEXT UNIQUE COLLATE NOCASE,
    invite_token TEXT UNIQUE,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    default_permissions TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );

  CREATE TABLE chat_members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    admin_rights TEXT NOT NULL DEFAULT '{}',
    custom_title TEXT NOT NULL DEFAULT '',
    muted_until INTEGER,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE INDEX idx_members_user ON chat_members(user_id);

  CREATE TABLE chat_bans (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by INTEGER,
    until INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    reply_to_id INTEGER,
    forwarded_from_id INTEGER,
    forwarded_from_name TEXT,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_chat ON messages(chat_id, id);

  CREATE TABLE message_files (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (message_id, file_id)
  );
  CREATE INDEX idx_message_files_file ON message_files(file_id);

  CREATE TABLE message_hidden (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE pinned_messages (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: channels, polls, notifications
  `
  ALTER TABLE chats ADD COLUMN sign_messages INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_members ADD COLUMN notify_muted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN signature TEXT;
  ALTER TABLE messages ADD COLUMN poll_id INTEGER REFERENCES polls(id);
  CREATE INDEX idx_messages_poll ON messages(poll_id) WHERE poll_id IS NOT NULL;

  CREATE TABLE polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    anonymous INTEGER NOT NULL DEFAULT 1,
    multiple INTEGER NOT NULL DEFAULT 0,
    quiz INTEGER NOT NULL DEFAULT 0,
    correct_option INTEGER,
    explanation TEXT NOT NULL DEFAULT '',
    closed INTEGER NOT NULL DEFAULT 0,
    close_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_polls_close ON polls(close_at) WHERE close_at IS NOT NULL AND closed = 0;

  CREATE TABLE poll_votes (
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_idx INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id, option_idx)
  );

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_push_user ON push_subscriptions(user_id);
  `,
  // v3: reactions, mentions, read receipts, folders, blocks, privacy, voice, comments, full-text search
  `
  CREATE TABLE message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX idx_mentions_user ON message_mentions(user_id, chat_id, message_id);

  CREATE TABLE read_log (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    up_to_id INTEGER NOT NULL,
    read_at INTEGER NOT NULL
  );
  CREATE INDEX idx_read_log ON read_log(chat_id, up_to_id);

  CREATE TABLE chat_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    filters TEXT NOT NULL DEFAULT '{}',
    include_ids TEXT NOT NULL DEFAULT '[]',
    exclude_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_folders_user ON chat_folders(user_id, position);

  CREATE TABLE user_blocks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
  CREATE INDEX idx_blocks_blocked ON user_blocks(blocked_id);

  ALTER TABLE chat_members ADD COLUMN pinned_at INTEGER;
  ALTER TABLE chat_members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chats ADD COLUMN reactions_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE chats ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE messages ADD COLUMN thread_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;
  CREATE INDEX idx_messages_thread ON messages(thread_id, id) WHERE thread_id IS NOT NULL;
  ALTER TABLE users ADD COLUMN privacy TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE files ADD COLUMN waveform TEXT;

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO messages_fts(rowid, text) SELECT id, text FROM messages WHERE kind != 'service' AND text != '';
  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind != 'service' AND new.text != '' BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages WHEN old.kind != 'service' AND old.text != '' BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
      SELECT 'delete', old.id, old.text WHERE old.kind != 'service' AND old.text != '';
    INSERT INTO messages_fts(rowid, text) SELECT new.id, new.text WHERE new.kind != 'service' AND new.text != '';
  END;
  `,
  // v4: the global admin can sign in as any user
  `
  ALTER TABLE sessions ADD COLUMN impersonator_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX idx_messages_sender ON messages(sender_id, created_at);
  `,
  // v5: built-in accounts (support chat, PupsoBank notifications)
  `
  ALTER TABLE users ADD COLUMN bot TEXT;
  CREATE UNIQUE INDEX idx_users_bot ON users(bot) WHERE bot IS NOT NULL;
  `,
  // v6: PupsoBank moves in: accounts belong to TimbaGram users, the cash is @admin's account
  `
  CREATE TABLE bank_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE bank_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    peer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    peer_name TEXT,
    message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_bank_ops_user ON bank_ops(user_id, id);
  CREATE INDEX idx_bank_ops_time ON bank_ops(created_at);

  CREATE TABLE bank_promos (
    code TEXT PRIMARY KEY COLLATE NOCASE,
    tcoins INTEGER NOT NULL,
    max_uses INTEGER,
    used INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE bank_promo_uses (
    code TEXT NOT NULL REFERENCES bank_promos(code) ON DELETE CASCADE ON UPDATE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (code, user_id)
  );
  `,
  // v7: УмныйТим is paid per block of output tokens
  `
  ALTER TABLE bank_accounts ADD COLUMN ai_tokens_used INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bank_accounts ADD COLUMN ai_tokens_paid INTEGER NOT NULL DEFAULT 0;
  `,
  // v8: top-ups by a money transfer, confirmed by the admin
  `
  CREATE TABLE bank_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX idx_bank_topups_user ON bank_topups(user_id, status);
  CREATE INDEX idx_bank_topups_message ON bank_topups(message_id);
  `,
  // v9: silent and scheduled messages, auto-delete timer, slow mode
  `
  ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN expires_at INTEGER;
  CREATE INDEX idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
  ALTER TABLE chats ADD COLUMN auto_delete INTEGER;
  ALTER TABLE chats ADD COLUMN slow_mode INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    reply_to_id INTEGER,
    file_ids TEXT NOT NULL DEFAULT '[]',
    silent INTEGER NOT NULL DEFAULT 0,
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_scheduled_due ON scheduled_messages(send_at);
  CREATE INDEX idx_scheduled_chat ON scheduled_messages(chat_id, user_id);
  `,
  // v10: ТК transfers and fundraisers in chats, checklists, reminders, voice transcripts
  `
  ALTER TABLE messages ADD COLUMN extra_id INTEGER;
  ALTER TABLE files ADD COLUMN transcript TEXT;

  CREATE TABLE chat_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    goal INTEGER,
    collected INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE fund_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_fund_contrib ON fund_contributions(fund_id);

  CREATE TABLE checklists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    others_can_add INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    done_at INTEGER
  );
  CREATE INDEX idx_checklist_items ON checklist_items(checklist_id, position);

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    chat_id INTEGER,
    snapshot TEXT NOT NULL DEFAULT '',
    remind_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_reminders_due ON reminders(remind_at);
  `,
  // v11: group calls by link
  `
  CREATE TABLE call_links (
    token TEXT PRIMARY KEY,
    creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // v12: phone numbers (optional, unverified: nobody offers free SMS without paperwork)
  `
  ALTER TABLE users ADD COLUMN phone TEXT;
  CREATE UNIQUE INDEX idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
  `,
  // v13: support tickets instead of a support chat
  `
  CREATE TABLE support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    operator_requested_at INTEGER,
    user_unread INTEGER NOT NULL DEFAULT 0,
    admin_unread INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tickets_user ON support_tickets(user_id, updated_at);
  CREATE INDEX idx_tickets_updated ON support_tickets(updated_at);
  CREATE TABLE support_ticket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_ticket_messages ON support_ticket_messages(ticket_id, id);
  `,
  // v14: the "Звонки" tab
  `
  CREATE TABLE call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    peer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER,
    link_token TEXT,
    title TEXT NOT NULL DEFAULT '',
    outgoing INTEGER NOT NULL DEFAULT 0,
    video INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_call_log_user ON call_log(user_id, started_at);
  `,
  // v15: TimbaGram Premium, paid like a top-up and checked by the admin
  `
  ALTER TABLE users ADD COLUMN premium_until INTEGER;
  ALTER TABLE bank_topups ADD COLUMN kind TEXT NOT NULL DEFAULT 'coins';
  `,
  // v16: promo codes for TimbaGram Premium (days NULL = forever)
  `
  CREATE TABLE premium_promos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    days INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE premium_promo_uses (
    promo_id INTEGER NOT NULL REFERENCES premium_promos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (promo_id, user_id)
  );
  `,
  // v17: subscribers the admin added to a channel on top of the real ones
  `
  ALTER TABLE chats ADD COLUMN boost_subscribers INTEGER NOT NULL DEFAULT 0;
  `,
  // v18: sticker packs (Премиум makes them, anybody adds them by a link); messages of kind "sticker"
  // keep "tg:<key>" or the image's file id in messages.sticker and the pack in extra_id
  `
  ALTER TABLE messages ADD COLUMN sticker TEXT;
  CREATE TABLE sticker_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sticker_packs_owner ON sticker_packs(owner_id);
  CREATE TABLE stickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id),
    emoji TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_stickers_pack ON stickers(pack_id, position);
  CREATE TABLE user_sticker_packs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, pack_id)
  );
  `,
  // v19: invite links with a limit, a deadline and approval; join requests; statistics of groups and channels
  `
  ALTER TABLE chats ADD COLUMN join_approval INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE chat_invites (
    token TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    usage_limit INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    approval INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_chat_invites_chat ON chat_invites(chat_id, created_at);
  CREATE TABLE join_requests (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_token TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE INDEX idx_join_requests_user ON join_requests(user_id);
  CREATE TABLE chat_member_log (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER,
    delta INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX idx_member_log ON chat_member_log(chat_id, at);
  INSERT INTO chat_member_log (chat_id, user_id, delta, at)
    SELECT m.chat_id, m.user_id, 1, m.joined_at FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE c.type != 'private';
  CREATE TABLE message_shares (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER,
    at INTEGER NOT NULL
  );
  CREATE INDEX idx_message_shares ON message_shares(chat_id, message_id);
  `,
  // v20: "mark as unread" in the chat list
  `
  ALTER TABLE chat_members ADD COLUMN marked_unread INTEGER NOT NULL DEFAULT 0;
  `,
  // v21: device bans — which accounts were used on which device, and the banned devices
  `
  CREATE TABLE user_devices (
    device_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (device_id, user_id)
  );
  CREATE INDEX idx_user_devices_user ON user_devices(user_id);
  CREATE TABLE banned_devices (
    device_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    banned_at INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_banned_devices_user ON banned_devices(user_id);
  `,
  // v22: notifications muted for a while (NULL with notify_muted = 1 means forever)
  `
  ALTER TABLE chat_members ADD COLUMN notify_muted_until INTEGER;
  `,
  // v23: the admin's badges (a small picture left of the name), coloured captions under the name and awards in the profile
  `
  CREATE TABLE badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    image BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE users ADD COLUMN badge_id INTEGER REFERENCES badges(id) ON DELETE SET NULL;
  CREATE INDEX idx_users_badge ON users(badge_id);
  CREATE TABLE user_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_user_tags_user ON user_tags(user_id);
  CREATE TABLE user_awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    degree INTEGER NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    awarded_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_user_awards_user ON user_awards(user_id, awarded_at);
  `,
  // v24: bots, as in Telegram. A bot is a user with is_bot = 1; its settings live in "bots", the events for it
  // in "bot_updates" (what getUpdates hands out), the keyboard it shows under the input field in "chat_keyboards"
  `
  ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN reply_markup TEXT;

  CREATE TABLE bots (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    builtin TEXT UNIQUE,
    token TEXT UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    commands TEXT NOT NULL DEFAULT '[]',
    can_join_groups INTEGER NOT NULL DEFAULT 1,
    privacy_mode INTEGER NOT NULL DEFAULT 1,
    allowed_updates TEXT,
    webhook_url TEXT,
    webhook_secret TEXT,
    webhook_error TEXT,
    webhook_error_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_bots_owner ON bots(owner_id);

  CREATE TABLE bot_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_bot_updates ON bot_updates(bot_id, id);

  CREATE TABLE chat_keyboards (
    chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    bot_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER,
    markup TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE bot_states (
    bot_id INTEGER NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, user_id)
  );
  `,
  // v25: the bots' till. wallet_owner = 1: the owner's balance is the bot's till. The admin may freeze a bot
  // (disabled) or switch its payments off. bot_invoices are the bills a bot sends (the Bot API's sendInvoice),
  // bot_ledger is the bot's own book: what came in and went out of its till
  `
  ALTER TABLE bots ADD COLUMN wallet_owner INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bots ADD COLUMN payments_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE bots ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE bot_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    fee INTEGER NOT NULL DEFAULT 0,
    wallet_user_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    paid_at INTEGER,
    refunded_at INTEGER
  );
  CREATE INDEX idx_bot_invoices_bot ON bot_invoices(bot_id, id);
  CREATE INDEX idx_bot_invoices_user ON bot_invoices(user_id, status);
  CREATE INDEX idx_bot_invoices_message ON bot_invoices(message_id);

  CREATE TABLE bot_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES bot_invoices(id) ON DELETE SET NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_bot_ledger ON bot_ledger(bot_id, id);
  `,
  // v26: who gets the daily forecast of the built-in weather bot, and how. chat_key is the Bot API's chat id:
  // the person's id for a private chat, minus the group's id for a group
  `
  CREATE TABLE weather_chats (
    chat_key INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    manager_id INTEGER,
    manager_username TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    time TEXT NOT NULL DEFAULT '08:00',
    level INTEGER NOT NULL DEFAULT 2,
    fields TEXT NOT NULL DEFAULT '{}',
    last_sent TEXT
  );
  `,
  // v27: every chat of the weather bot has a city of its own (null until chosen). The ones that subscribed
  // when the bot knew only Архангельск keep it; last_sent is a date in the city's time zone
  `
  ALTER TABLE weather_chats ADD COLUMN city_id INTEGER;
  ALTER TABLE weather_chats ADD COLUMN city_name TEXT;
  ALTER TABLE weather_chats ADD COLUMN city_label TEXT;
  ALTER TABLE weather_chats ADD COLUMN city_lat REAL;
  ALTER TABLE weather_chats ADD COLUMN city_lon REAL;
  ALTER TABLE weather_chats ADD COLUMN city_tz TEXT;
  UPDATE weather_chats SET city_id = 581049, city_name = 'Архангельск', city_label = 'Архангельск, Архангельская область',
    city_lat = 64.5461, city_lon = 40.5518, city_tz = 'Europe/Moscow';
  `,
  // v28: "Контакты" are the people a user saved, not everybody. Those a user already writes to stay in the list
  `
  CREATE TABLE user_contacts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, contact_id)
  );
  CREATE INDEX idx_user_contacts_contact ON user_contacts(contact_id);
  INSERT OR IGNORE INTO user_contacts (user_id, contact_id, created_at)
    SELECT m.user_id, o.user_id, c.created_at
    FROM chats c
    JOIN chat_members m ON m.chat_id = c.id
    JOIN chat_members o ON o.chat_id = c.id AND o.user_id != m.user_id
    JOIN users u ON u.id = o.user_id AND u.is_bot = 0 AND u.bot IS NULL
    WHERE c.type = 'private';
  `,
  // v-last: the message texts are encrypted (crypt.ts), so the full-text index, which held them in the clear, goes
  `
  DROP TRIGGER IF EXISTS messages_fts_ai;
  DROP TRIGGER IF EXISTS messages_fts_ad;
  DROP TRIGGER IF EXISTS messages_fts_au;
  DROP TABLE IF EXISTS messages_fts;
  `,
  // a ticket the operator has already answered no longer "waits for an operator"
  `
  UPDATE support_tickets SET status = 'answered'
    WHERE status = 'operator'
      AND (SELECT m.author FROM support_ticket_messages m WHERE m.ticket_id = support_tickets.id AND m.author != 'system' ORDER BY m.id DESC LIMIT 1) = 'operator';
  `,
];

export function initDb(file: string): DB {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // 32 MB of pages stay in memory (the default is 2 MB), sorting and temporary tables never touch the disk,
  // and the file is read through the memory map instead of read() calls
  db.pragma('cache_size = -32768');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 134217728');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  // message texts are kept encrypted: what is still plain (older messages) is encrypted once, and the old index
  // pages and the log, which held the plain texts, are scrubbed out of the file
  installDecryption(db);
  // the full-text index held the texts in the clear: it must not be left behind, whatever version the file came from
  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    DROP TABLE IF EXISTS messages_fts;
  `);
  if (encryptExisting(db)) {
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
  // the planner learns the size of the tables from time to time (a quick look at a few rows of each index)
  db.pragma('analysis_limit = 400');
  db.pragma('optimize');
  // search by #hashtags: FTS drops the "#", so the exact tags are checked on the text (case-insensitive)
  db.function('tg_has_tags', { deterministic: true }, (text: unknown, tags: unknown) => {
    const have = new Set(String(text ?? '').toLowerCase().match(HASHTAG_RE) ?? []);
    return String(tags ?? '')
      .split(' ')
      .filter(Boolean)
      .every((tag) => have.has(tag))
      ? 1
      : 0;
  });
  return db;
}

export const now = () => Date.now();
