export const APP_NAME = 'TimbaGram';
export const APP_VERSION = '0.1.0';

export const ADMIN_USERNAME = 'admin';
export const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_ATTACHMENTS = 10;
export const MESSAGES_PAGE = 50;
/** muted_until value meaning "forever" */
export const MUTE_FOREVER = 253402300799000;

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX = 255;
export const POLL_OPTION_MAX = 100;
export const POLL_EXPLANATION_MAX = 200;

/** Reactions; the first QUICK_REACTIONS are offered in the message menu */
export const REACTIONS = [
  '👍', '❤️', '🔥', '😂', '😮', '😢', '👎',
  '🎉', '🤩', '👏', '🙏', '🤔', '🤯', '😱', '🤬', '💩', '🤡', '🥰', '😍', '😁',
  '🤝', '💯', '⚡', '🏆', '🍓', '🍾', '💔', '🥴', '😴', '🙈', '🗿', '👀',
] as const;
export const QUICK_REACTIONS = 7;
export const MAX_PINNED_CHATS = 5;
export const MAX_FOLDERS = 10;
/** accounts signed in on one browser at the same time (Telegram: 3, 4 with Premium) */
export const MAX_ACCOUNTS = 3;
export const MAX_ACCOUNTS_PREMIUM = 5;
/** "who read" is shown in groups up to this size, for messages up to READERS_DAYS old */
export const READERS_MAX_MEMBERS = 100;
export const READERS_DAYS = 7;
export const VOICE_MAX_SECONDS = 15 * 60;
export const ROUND_MAX_SECONDS = 60;
export const WAVEFORM_BARS = 48;

export const CHECKLIST_MAX_ITEMS = 30;

/**
 * Боты, как в Telegram: их создают в Профиле → Расширенные настройки → Боты. Создание стоит ТК (цену меняет админ), при удалении бота
 * деньги не возвращаются. Бот — особый пользователь, чей username заканчивается на «bot».
 */
export const BOT_CREATE_PRICE = 20;
export const BOT_MAX_PER_USER = 20;
export const BOT_NAME_MAX = 64;
/** «О боте» (about): короткий текст в профиле */
export const BOT_ABOUT_MAX = 120;
/** описание — «Что умеет этот бот?» в пустом чате */
export const BOT_DESCRIPTION_MAX = 512;
export const BOT_COMMANDS_MAX = 100;
export const BOT_COMMAND_RE = /^[a-z0-9_]{1,32}$/;
export const BOT_COMMAND_DESC_MIN = 1;
export const BOT_COMMAND_DESC_MAX = 256;
export const BOT_CALLBACK_DATA_MAX = 64;
/** кнопок под сообщением и в клавиатуре (как в Telegram) */
export const BOT_BUTTONS_MAX = 100;
export const BOT_BUTTON_TEXT_MAX = 64;
/** обновления ждут бота в очереди столько же, сколько в Telegram */
export const BOT_UPDATES_TTL_MS = 24 * 3600_000;
export const BOT_UPDATES_MAX = 5000;
/** встроенный бот «Погода»: прогноз для выбранного города каждое утро */
export const WEATHERBOT_USERNAME = 'WeatherBot';
/** встроенный магазин TimbaGram Premium: продаёт Премиум за ТК */
export const PREMIUMBOT_USERNAME = 'PremiumBot';
/** что продаёт @PremiumBot: на сколько дней и за сколько ТК */
export const PREMIUM_SHOP: readonly { days: number; price: number }[] = [
  { days: 1, price: 30 },
  { days: 7, price: 199 },
  { days: 30, price: 499 },
];
/** логины, оканчивающиеся на bot, принадлежат только ботам */
export const isBotUsername = (username: string) => /bot$/i.test(username);
/** кнопки ответа ботам ждут не дольше */
export const BOT_CALLBACK_WAIT_MS = 15_000;

/**
 * Счета ботов в ТК. Лимиты Telegram'а для счетов: заголовок до 32 знаков, описание до 255, payload до 128 байт.
 * Админ меняет максимальную сумму, комиссию и срок жизни счёта (вкладка «Боты»).
 */
export const BOT_INVOICE_TITLE_MAX = 32;
export const BOT_INVOICE_DESCRIPTION_MAX = 255;
export const BOT_INVOICE_PAYLOAD_MAX = 128;
export const BOT_INVOICE_MAX_AMOUNT = 100_000;
/** счёт без срока действует так долго, часов */
export const BOT_INVOICE_TTL_HOURS = 24 * 7;
export const BOT_FEE_PERCENT = 0;

/** auto-delete timer of a chat, seconds */
export const AUTO_DELETE_OPTIONS = [86400, 7 * 86400, 30 * 86400];
/** slow mode in groups, seconds (0 = off) */
export const SLOW_MODE_OPTIONS = [0, 10, 30, 60, 300, 900, 3600];
/** a message may be scheduled up to a year ahead, at least this far */
export const SCHEDULE_MIN_MS = 10_000;
export const SCHEDULE_MAX_MS = 365 * 86400_000;

/** PupsoBank: ТимбаКоины (ТК); defaults, the admin can change them */
export const BANK_START_BALANCE = 10;
export const BANK_JOKE_PRICE = 5;
/** top-up: 1 ТК = 1 ₽ transferred to this phone number, confirmed by the admin */
export const BANK_TOPUP_PHONE = '79214822402';
export const BANK_TOPUP_MAX = 100_000;
export const BANK_TOPUP_PRESETS = [50, 100, 200, 500];
export const BANK_MESSAGE_MAX = 200;

/** TimbaGram Premium: a month for PREMIUM_PRICE ₽ (the admin can change the price), paid like a top-up */
export const PREMIUM_PRICE = 399;
export const PREMIUM_DAYS = 30;
/** ТК every premium user gets once a week, the first ones on the day the premium starts */
export const PREMIUM_WEEKLY_BONUS = 40;
/** most fake subscribers a channel can have */
export const BOOST_MAX = 10_000_000;
/** premium users may upload files this many times larger than the admin's limit */
export const PREMIUM_UPLOAD_FACTOR = 4;
/** premium_until of a premium without an end (1 January 3000) */
export const PREMIUM_FOREVER = 32_503_680_000_000;
export const isPremiumForever = (until: number | null | undefined) => !!until && until >= PREMIUM_FOREVER;
/** promo codes for Премиум: letters, digits and dashes */
export const PROMO_CODE_MAX = 32;

/** Казино (TimbaGram Premium): bets in ТК */
export const CASINO_MIN_BET = 1;
export const CASINO_MAX_BET = 10_000;
/** slot symbols from the most common to the rarest */
export const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '⭐', '💎', '7️⃣'];
/** three of the same symbol pay the bet × this, per symbol */
export const SLOT_THREE = [8, 12, 20, 40, 80, 200, 777];
/** two of the same symbol on any two reels pay the bet × this (0: nothing); the common ones pay nothing to keep ~90% back */
export const SLOT_PAIR = [0, 0, 1, 1, 3, 5, 10];
/** red numbers of the roulette; the rest but 0 are black */
export const ROULETTE_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
export const AI_QUESTION_MAX = 1000;

/** Multiplayer games on ТК: the duel's chances to hit, %, and the timers */
export const DUEL_BASE_CHANCE = 30;
export const DUEL_AIM_STEP = 20;
export const DUEL_MAX_CHANCE = 90;
/** a duel move (or a dice round) not made in time: the duel is lost, the die is rolled by the server */
export const PVP_TURN_MS = 3 * 60_000;
/** an invite nobody answered is gone after this long */
export const PVP_INVITE_MS = 15 * 60_000;
/** open invites one player may have sent at a time */
export const PVP_MAX_OPEN = 5;



/** Socket.IO event names (server -> client) */
export const EV = {
  messageNew: 'message:new',
  messageEdit: 'message:edit',
  messageDelete: 'message:delete',
  chatCleared: 'chat:cleared',
  messageRead: 'message:read',
  chatUpdate: 'chat:update',
  chatRemoved: 'chat:removed',
  membersChanged: 'chat:members',
  pinsChanged: 'chat:pins',
  pollUpdate: 'poll:update',
  reactions: 'message:reactions',
  foldersUpdate: 'folders:update',
  typing: 'typing',
  presence: 'presence',
  userUpdate: 'user:update',
  accountBanned: 'account:banned',
  sessionRevoked: 'session:revoked',
  appStatus: 'app:status',
  callIncoming: 'call:incoming',
  callAccepted: 'call:accepted',
  callSignal: 'call:signal',
  callEnd: 'call:end',
  supportTicket: 'support:ticket',
  notification: 'notification',
  groupCallState: 'gcall:state',
  groupCallJoined: 'gcall:joined',
  groupCallLeft: 'gcall:left',
  groupCallSignal: 'gcall:signal',
  groupCallMedia: 'gcall:media',
  /** the user's sticker packs changed (another tab added or edited one) */
  stickersUpdate: 'stickers:update',
  pvp: 'pvp:update',
  /** бот ответил на нажатие кнопки под сообщением (answerCallbackQuery) */
  botCallbackAnswer: 'bot:callback',
  /** у бота изменились команды, описание или настройки */
  botUpdate: 'bot:update',
} as const;

/** an unanswered call stops ringing after this long */
export const CALL_RING_MS = 45_000;

/** a group call is a mesh (everybody sends to everybody): more people would choke phones */
export const GROUP_CALL_MAX = 10;

/** importing the phone book: people in one request, numbers of one person. A big book is sent in several requests. */
export const CONTACTS_IMPORT_CHUNK = 500;
export const CONTACT_PHONES_MAX = 5;

/** Стикеры: packs a Премиум user may make, stickers in one pack */
export const MAX_STICKER_PACKS = 10;
export const MAX_STICKERS_PER_PACK = 120;
export const STICKER_PACK_TITLE_MAX = 64;
/** built-in TimbaGram smileys: the client draws them, messages store "tg:<key>" */
export const BUILTIN_STICKER_PREFIX = 'tg:';
export const BUILTIN_STICKERS: readonly { key: string; emoji: string }[] = [
  { key: 'hi', emoji: '👋' },
  { key: 'happy', emoji: '😊' },
  { key: 'lol', emoji: '😂' },
  { key: 'love', emoji: '😍' },
  { key: 'wink', emoji: '😉' },
  { key: 'cool', emoji: '😎' },
  { key: 'kiss', emoji: '😘' },
  { key: 'shy', emoji: '☺️' },
  { key: 'tongue', emoji: '😜' },
  { key: 'wow', emoji: '😮' },
  { key: 'think', emoji: '🤔' },
  { key: 'sad', emoji: '😢' },
  { key: 'cry', emoji: '😭' },
  { key: 'angry', emoji: '😡' },
  { key: 'scared', emoji: '😱' },
  { key: 'sleep', emoji: '😴' },
  { key: 'party', emoji: '🥳' },
  { key: 'like', emoji: '👍' },
  { key: 'rich', emoji: '🤑' },
  { key: 'star', emoji: '🤩' },
  { key: 'facepalm', emoji: '🤦' },
  { key: 'heart', emoji: '❤️' },
  { key: 'dead', emoji: '😵' },
  { key: 'ok', emoji: '👌' },
];
export const builtinSticker = (id: string) =>
  id.startsWith(BUILTIN_STICKER_PREFIX) ? BUILTIN_STICKERS.find((s) => s.key === id.slice(BUILTIN_STICKER_PREFIX.length)) : undefined;

/** the kinds of a support ticket (a plain list: the client reads it too, and must not need the validators for it) */
export const TICKET_TYPES = ['problem', 'question', 'payment', 'suggestion', 'complaint', 'other'] as const;
