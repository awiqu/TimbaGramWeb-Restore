import { z } from 'zod';
import {
  AWARD_CAPTION_MAX,
  AWARD_DEGREE_MAX,
  AWARD_DEGREE_MIN,
  BADGE_TITLE_MAX,
  TAG_COLOR_RE,
  TAG_TEXT_MAX,
} from './awards.js';
import { LABEL_MAX } from './labels.js';
import {
  BOOST_MAX,
  BOT_CALLBACK_DATA_MAX,
  STICKER_PACK_TITLE_MAX,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  BANK_MESSAGE_MAX,
  BANK_TOPUP_MAX,
  CASINO_MAX_BET,
  CASINO_MIN_BET,
  CHECKLIST_MAX_ITEMS,
  CONTACT_PHONES_MAX,
  CONTACTS_IMPORT_CHUNK,
  AUTO_DELETE_OPTIONS,
  SLOW_MODE_OPTIONS,
  POLL_EXPLANATION_MAX,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  REACTIONS,
  USERNAME_RE,
  WAVEFORM_BARS,
  TICKET_TYPES,
} from './constants.js';

export const usernameSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .regex(USERNAME_RE, 'Имя пользователя: 3–32 символа, латиница, цифры и _, начинается с буквы'),
  );

export const passwordSchema = z.string().min(6, 'Пароль минимум 6 символов').max(128);
const nameSchema = z.string().trim().max(64);

/**
 * A phone number in any usual spelling ("8 (921) 123-45-67", "+7 921 1234567") becomes "+79211234567".
 * An empty string means "no number".
 */
export function normalizePhone(input: string): string {
  let digits = input.replace(/[^\d]/g, '');
  if (!digits) return '';
  // Russian numbers written with a leading 8 or without the country code
  if (digits.length === 11 && digits.startsWith('8') && !input.trim().startsWith('+')) digits = `7${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  return `+${digits}`;
}

export const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .refine((v) => !v || /^[\d\s()+\-.]+$/.test(v), 'Номер телефона: только цифры, пробелы, скобки, дефисы и +')
  .transform(normalizePhone)
  .refine((v) => !v || (v.length >= 11 && v.length <= 16), 'Проверьте номер телефона: не хватает или слишком много цифр');

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  firstName: nameSchema.optional().default(''),
  lastName: nameSchema.optional().default(''),
  phone: phoneSchema.optional().default(''),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});

export const updateProfileSchema = z.object({
  username: usernameSchema.optional(),
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  bio: z.string().trim().max(200).optional(),
  avatarFileId: z.string().max(64).nullable().optional(),
  phone: phoneSchema.optional(),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const prefsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  colorTheme: z.string().max(32).optional(),
  /** before themes: a separately picked accent color and chat background, read only to find the closest theme */
  accent: z.string().max(16).optional(),
  wallpaper: z.string().max(32).optional(),
  fontSize: z.number().min(12).max(22).optional(),
  notifySound: z.boolean().optional(),
  quietHours: z
    .object({
      on: z.boolean(),
      from: z.number().int().min(0).max(1439),
      to: z.number().int().min(0).max(1439),
      tz: z.number().int().min(-840).max(840),
    })
    .optional(),
  quickReaction: z.enum(REACTIONS as unknown as [string, ...string[]]).optional(),
});

export const sendMessageSchema = z
  .object({
    text: z.string().max(MAX_MESSAGE_LENGTH).optional().default(''),
    replyToId: z.number().int().positive().nullable().optional(),
    fileIds: z.array(z.string().max(64)).max(MAX_ATTACHMENTS).optional().default([]),
    clientId: z.string().max(64).optional(),
    /** comments under a channel post */
    threadId: z.number().int().positive().nullable().optional(),
    /** no sound and no push for the recipients */
    silent: z.boolean().optional().default(false),
    /** schedule: send at this time (ms) instead of now */
    sendAt: z.number().int().positive().nullable().optional().default(null),
    /** a sticker instead of text and files: "tg:<key>" or a custom sticker's number */
    stickerId: z.string().max(64).nullable().optional().default(null),
  })
  .refine((v) => v.text.trim().length > 0 || v.fileIds.length > 0 || !!v.stickerId, 'Пустое сообщение');

/** What the browser knows about a video it has just sent: its size, its length and a frame (a "data:image/jpeg;base64,…" picture). */
export const fileMetaSchema = z.object({
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
  duration: z.number().positive().max(86400).optional(),
  poster: z.string().max(600_000).optional(),
});

export const editMessageSchema = z.object({
  text: z.string().max(MAX_MESSAGE_LENGTH),
});

// a message goes for everybody unless the sender asks to keep it for the other side
export const deleteMessagesSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  forAll: z.boolean().optional().default(true),
});

/** «Очистить историю»: for everybody when allowed (the default), otherwise only for the one who clears */
export const clearHistorySchema = z.object({
  forAll: z.boolean().optional(),
});

export const forwardSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  fromChatId: z.number().int().positive(),
  toChatId: z.number().int().positive(),
  /** send as a copy: no «Переслано от» line */
  hideSender: z.boolean().optional().default(false),
});

export const createPollSchema = z
  .object({
    question: z.string().trim().min(1, 'Введите вопрос').max(POLL_QUESTION_MAX),
    options: z
      .array(z.string().trim().min(1, 'Пустой вариант ответа').max(POLL_OPTION_MAX))
      .min(POLL_MIN_OPTIONS, `Нужно минимум ${POLL_MIN_OPTIONS} варианта`)
      .max(POLL_MAX_OPTIONS, `Не больше ${POLL_MAX_OPTIONS} вариантов`),
    anonymous: z.boolean().optional().default(true),
    multiple: z.boolean().optional().default(false),
    quiz: z.boolean().optional().default(false),
    correctOption: z.number().int().min(0).nullable().optional().default(null),
    explanation: z.string().trim().max(POLL_EXPLANATION_MAX).optional().default(''),
    /** seconds until the poll closes automatically (5 min … 30 days) */
    closePeriod: z.number().int().min(60).max(30 * 86400).nullable().optional().default(null),
    replyToId: z.number().int().positive().nullable().optional(),
    clientId: z.string().max(64).optional(),
    threadId: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => new Set(v.options.map((o) => o.toLowerCase())).size === v.options.length, 'Варианты не должны повторяться')
  .refine((v) => !v.quiz || (v.correctOption !== null && v.correctOption < v.options.length), 'Выберите правильный ответ')
  .refine((v) => !(v.quiz && v.multiple), 'В викторине можно выбрать только один ответ');

export const votePollSchema = z.object({
  /** empty = retract the vote */
  options: z.array(z.number().int().min(0).max(POLL_MAX_OPTIONS - 1)).max(POLL_MAX_OPTIONS),
});

export const reactionSchema = z.object({
  emoji: z.enum(REACTIONS as unknown as [string, ...string[]]),
});

const privacyValue = z.enum(['everybody', 'nobody']);
export const privacySchema = z.object({
  lastSeen: privacyValue.optional(),
  avatar: privacyValue.optional(),
  groupInvites: privacyValue.optional(),
  phone: privacyValue.optional(),
});

export const folderSchema = z.object({
  title: z.string().trim().min(1, 'Введите название папки').max(24),
  filters: z
    .object({
      private: z.boolean().default(false),
      groups: z.boolean().default(false),
      channels: z.boolean().default(false),
      excludeMuted: z.boolean().default(false),
      excludeRead: z.boolean().default(false),
      excludeArchived: z.boolean().default(true),
    })
    .default({}),
  includeIds: z.array(z.number().int().positive()).max(200).default([]),
  excludeIds: z.array(z.number().int().positive()).max(200).default([]),
});

export const folderOrderSchema = z.object({
  ids: z.array(z.number().int().positive()).max(50),
});

export const waveformSchema = z.array(z.number().int().min(0).max(31)).length(WAVEFORM_BARS);

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export const notificationsSchema = z.object({
  muted: z.boolean(),
  /** with muted: for this long (a minute … a year); without it — for good */
  seconds: z.number().int().min(60).max(366 * 86400).optional(),
});

export const groupPermissionsSchema = z.object({
  sendMessages: z.boolean(),
  sendMedia: z.boolean(),
  sendPolls: z.boolean().optional().default(true),
  inviteUsers: z.boolean(),
  pinMessages: z.boolean(),
});

export const adminRightsSchema = z.object({
  changeInfo: z.boolean(),
  deleteMessages: z.boolean(),
  banUsers: z.boolean(),
  inviteUsers: z.boolean(),
  pinMessages: z.boolean(),
  addAdmins: z.boolean(),
  postMessages: z.boolean().optional().default(false),
  editMessages: z.boolean().optional().default(false),
});

export const createGroupSchema = z.object({
  title: z.string().trim().min(1, 'Введите название').max(64),
  description: z.string().trim().max(255).optional().default(''),
  avatarFileId: z.string().max(64).nullable().optional(),
  isPublic: z.boolean().optional().default(false),
  publicUsername: usernameSchema.nullable().optional(),
  memberIds: z.array(z.number().int().positive()).max(200).optional().default([]),
  /** channels only */
  signMessages: z.boolean().optional().default(false),
});

export const updateGroupSchema = z.object({
  title: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(255).optional(),
  avatarFileId: z.string().max(64).nullable().optional(),
  isPublic: z.boolean().optional(),
  publicUsername: usernameSchema.nullable().optional(),
  defaultPermissions: groupPermissionsSchema.optional(),
  signMessages: z.boolean().optional(),
  reactionsEnabled: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
  /** seconds between messages of a member; 0 = off */
  slowMode: z.number().int().refine((v) => SLOW_MODE_OPTIONS.includes(v), 'Недопустимое значение').optional(),
  /** public groups and channels: people send a request and an admin lets them in */
  joinApproval: z.boolean().optional(),
});

export const createInviteSchema = z.object({
  title: z.string().trim().max(32).default(''),
  /** ms timestamp; null = forever */
  expiresAt: z.number().int().positive().nullable().default(null),
  /** how many people may join by it; null = unlimited */
  usageLimit: z.number().int().min(1).max(99999).nullable().default(null),
  approval: z.boolean().default(false),
});

export const decideRequestSchema = z.object({
  approve: z.boolean(),
});

export const autoDeleteSchema = z.object({
  /** seconds; null = off */
  seconds: z
    .number()
    .int()
    .nullable()
    .refine((v) => v === null || AUTO_DELETE_OPTIONS.includes(v), 'Недопустимое значение'),
});

export const updateMemberSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  rights: adminRightsSchema.optional(),
  customTitle: z.string().trim().max(16).optional(),
});

export const untilSchema = z.object({
  /** ms timestamp; null = forever */
  until: z.number().int().nullable().optional().default(null),
});

export const adminSettingsSchema = z.object({
  maintenance: z.boolean().optional(),
  maintenanceMessage: z.string().max(500).optional(),
  registrationOpen: z.boolean().optional(),
  maxUploadMb: z.number().int().min(1).max(4096).optional(),
  appName: z.string().trim().min(1).max(32).optional(),
  version: z.string().trim().min(1).max(32).optional(),
  announcement: z.string().trim().max(500).optional(),
  groupCreation: z.boolean().optional(),
  channelCreation: z.boolean().optional(),
  uploadsEnabled: z.boolean().optional(),
  donateUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !v || /^https:\/\/[^\s]+$/.test(v), 'Ссылка должна начинаться с https://')
    .optional(),
  topupUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || /^https?:\/\/[^\s]+$/.test(v), 'Ссылка должна начинаться с https://')
    .optional(),
  premiumUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || /^https?:\/\/[^\s]+$/.test(v), 'Ссылка должна начинаться с https://')
    .optional(),
  premiumPrice: z.number().int().min(1).max(100_000).optional(),
  supportBot: z.boolean().optional(),
  /** make every open client reload */
  forceReload: z.boolean().optional(),
});

export const adminSendSchema = z.object({
  asUserId: z.number().int().positive(),
  text: z.string().trim().min(1, 'Пустое сообщение').max(MAX_MESSAGE_LENGTH),
  replyToId: z.number().int().positive().nullable().optional(),
});

export const adminBroadcastSchema = z.object({
  text: z.string().trim().min(1, 'Пустое сообщение').max(MAX_MESSAGE_LENGTH),
});

export const adminPasswordSchema = z.object({
  password: passwordSchema,
});

export const adminDeleteUserSchema = z.object({
  /** also delete everything the user wrote in groups and channels */
  wipeMessages: z.boolean().optional().default(false),
});

export const banUserSchema = z.object({
  reason: z.string().trim().max(200).optional().default(''),
  /** also ban every device the account was used on */
  devices: z.boolean().optional().default(false),
});

export const banDeviceSchema = z.object({
  reason: z.string().trim().max(200).optional().default(''),
});

export const bankTransferSchema = z.object({
  userId: z.number().int().positive(),
  amount: z.number().int('Только целое число').positive('Сумма должна быть больше нуля').max(1_000_000_000),
  message: z.string().trim().max(BANK_MESSAGE_MAX).optional().default(''),
});

export const bankPromoSchema = z.object({
  code: z.string().trim().min(1, 'Введите промокод').max(64),
});

export const adminBankGiveSchema = z.object({
  userId: z.number().int().positive(),
  /** add (negative = take) or, with `set`, the new balance */
  amount: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  set: z.boolean().optional().default(false),
  reason: z.string().trim().max(200).optional().default(''),
  /** tell the user in the ПупсоБанк chat */
  notify: z.boolean().optional().default(true),
});

export const adminBankPromoSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-zА-Яа-яЁё0-9_-]+$/, 'Только буквы, цифры, - и _'),
  tcoins: z.number().int().positive(),
  maxUses: z.number().int().positive().nullable().optional().default(null),
});

export const adminBankPromoPatchSchema = z.object({
  active: z.boolean().optional(),
  tcoins: z.number().int().positive().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
});

export const adminBankSettingsSchema = z.object({
  startBalance: z.number().int().min(0).max(1_000_000).optional(),
  jokePrice: z.number().int().min(0).max(1_000_000).optional(),
  botPrice: z.number().int().min(0).max(1_000_000).optional(),
});

export const adminBotSettingsSchema = z.object({
  createEnabled: z.boolean().optional(),
  maxPerUser: z.number().int().min(0).max(1000).optional(),
  paymentsEnabled: z.boolean().optional(),
  feePercent: z.number().int().min(0).max(90).optional(),
  maxInvoice: z.number().int().min(1).max(10_000_000).optional(),
  invoiceTtlHours: z.number().int().min(1).max(24 * 365).optional(),
});

export const botCommandSchema = z.object({
  command: z.string().min(1).max(33),
  description: z.string().min(1).max(256),
});

export const createBotSchema = z.object({
  name: z.string().trim().min(1, 'Введите имя бота').max(64, 'Имя бота — до 64 символов'),
  username: z.string().trim().min(1, 'Введите username'),
});

/** Changes of a bot made in the manager; a missing field stays as it is. */
export const myBotPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  username: z.string().trim().min(1).optional(),
  description: z.string().max(512).optional(),
  about: z.string().max(120).optional(),
  commands: z.array(botCommandSchema).max(100).optional(),
  canJoinGroups: z.boolean().optional(),
  privacyMode: z.boolean().optional(),
  wallet: z.enum(['bot', 'owner']).optional(),
  avatarFileId: z.string().min(1).nullable().optional(),
});

export const botWithdrawSchema = z.object({ amount: z.number().int().min(1).max(100_000_000).optional() });

export const adminBotPatchSchema = z.object({
  disabled: z.boolean().optional(),
  paymentsEnabled: z.boolean().optional(),
});

export const bankTopupSchema = z.object({
  amount: z.number().int('Только целое число').min(1, 'Сумма должна быть больше нуля').max(BANK_TOPUP_MAX),
});

export const chatTransferSchema = z.object({
  toUserId: z.number().int().positive(),
  amount: z.number().int('Только целое число').positive('Сумма должна быть больше нуля').max(1_000_000_000),
  comment: z.string().trim().max(BANK_MESSAGE_MAX).optional().default(''),
  clientId: z.string().max(64).optional(),
});

export const createFundSchema = z.object({
  title: z.string().trim().min(1, 'Напишите, на что собираем').max(100),
  goal: z.number().int().positive().max(1_000_000_000).nullable().optional().default(null),
  clientId: z.string().max(64).optional(),
});

export const fundContributeSchema = z.object({
  amount: z.number().int('Только целое число').positive('Сумма должна быть больше нуля').max(1_000_000_000),
});

export const createChecklistSchema = z.object({
  title: z.string().trim().min(1, 'Введите название списка').max(100),
  items: z.array(z.string().trim().min(1).max(200)).min(1, 'Добавьте хотя бы один пункт').max(CHECKLIST_MAX_ITEMS),
  othersCanAdd: z.boolean().optional().default(true),
  clientId: z.string().max(64).optional(),
});

export const checklistAddSchema = z.object({
  text: z.string().trim().min(1).max(200),
});

export const remindSchema = z.object({
  at: z.number().int().positive(),
});

export const addContactSchema = z.object({
  userId: z.number().int().positive(),
});

/** The phone book: one entry per person, each with the numbers as written there. Names stay on the phone. */
export const importContactsSchema = z.object({
  contacts: z
    .array(z.array(z.string().trim().max(40)).max(CONTACT_PHONES_MAX))
    .max(CONTACTS_IMPORT_CHUNK, 'Слишком много контактов за один раз'),
});

export const createCallLinkSchema = z.object({
  title: z.string().trim().max(64).optional(),
});

export const createTicketSchema = z.object({
  type: z.enum(TICKET_TYPES),
  text: z.string().trim().min(5, 'Опишите вопрос подробнее').max(4000),
});

export const ticketMessageSchema = z.object({
  text: z.string().trim().min(1, 'Введите сообщение').max(4000),
});

/** Channel subscriber boost: add to (negative = remove) or replace the admin's extra subscribers. */
export const adminBoostSchema = z.object({
  mode: z.enum(['add', 'set']),
  count: z.number().int('Только целое число').min(-BOOST_MAX).max(BOOST_MAX),
});

/**
 * The admin changes premium: give = extend by `days`, forever = without an end, until = end exactly at
 * `until` (later or earlier than now's end), cut = shorten by `days`, remove = take away.
 */
export const adminPremiumSchema = z.object({
  action: z.enum(['give', 'forever', 'until', 'cut', 'remove']),
  days: z.number().int().min(1).max(3650).optional(),
  until: z.number().int().positive().optional(),
  notify: z.boolean().optional(),
});

const promoCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9А-ЯЁ_-]{3,32}$/, 'Код: от 3 до 32 букв, цифр, «-» или «_»');

/** a promo code for Премиум: `days` null = forever; no code = a random one */
export const adminPromoSchema = z.object({
  code: promoCode.optional(),
  days: z.number().int().min(1).max(3650).nullable(),
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

export const redeemPromoSchema = z.object({
  code: z.string().trim().toUpperCase().min(1, 'Введите промокод').max(64),
});

const casinoAmount = z.number().int('Только целое число').min(CASINO_MIN_BET, 'Ставка слишком маленькая').max(CASINO_MAX_BET, 'Ставка слишком большая');

export const casinoSlotsSchema = z.object({ amount: casinoAmount });

export const casinoRouletteSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('number'), value: z.number().int().min(0).max(36), amount: casinoAmount }),
  z.object({ type: z.literal('dozen'), value: z.union([z.literal(1), z.literal(2), z.literal(3)]), amount: casinoAmount }),
  z.object({ type: z.enum(['red', 'black', 'even', 'odd', 'low', 'high']), amount: casinoAmount }),
]);
export const pvpCreateSchema = z.object({
  game: z.enum(['duel', 'dice', 'tictactoe', 'connect4', 'rps', 'nim']),
  userId: z.number().int().positive(),
  stake: casinoAmount,
});

export const gameScoreSchema = z.object({
  game: z.string().min(1).max(32),
  score: z.number().finite(),
});

/** `since`: when this device last took the server's saves (the `at` of that answer, 0 when never); old clients send none */
export const gameSavesSchema = z.object({ saves: z.record(z.unknown()), since: z.number().finite().min(0).optional() });

export const pvpMoveSchema = z.object({
  action: z.enum(['shoot', 'aim', 'knock', 'roll', 'mark', 'drop', 'pick', 'add']),
  /** mark: the cell, drop: the column, add: the number, pick: 'rock' | 'scissors' | 'paper' */
  value: z.union([z.number().int(), z.enum(['rock', 'scissors', 'paper'])]).optional(),
});

/** Надписи из админ-панели: новый текст или null — вернуть исходный */
export const adminLabelsSchema = z.object({
  set: z
    .record(z.string().max(200).regex(/^[\w.]+$/), z.string().max(LABEL_MAX).nullable())
    .refine((r) => Object.keys(r).length <= 5000),
  /** сразу перезагрузить все открытые вкладки, чтобы новые надписи применились */
  reload: z.boolean().optional(),
});

export const stickerPackTitleSchema = z.object({
  title: z.string().trim().min(1, 'Введите название пака').max(STICKER_PACK_TITLE_MAX),
});

/** one emoji (or a short emoji sequence) the sticker stands for */
const stickerEmoji = z.string().trim().min(1, 'Выберите эмодзи').max(16);

export const addStickerSchema = z.object({
  fileId: z.string().min(1).max(64),
  emoji: stickerEmoji,
});

export const editStickerSchema = z.object({
  emoji: stickerEmoji.optional(),
  /** a new picture */
  fileId: z.string().min(1).max(64).optional(),
  /** new place in the pack, 0-based */
  position: z.number().int().min(0).optional(),
});

// ---------- значки, награды и подписи профиля (админ) ----------

/** название значка; картинка приходит файлом */
export const adminBadgeSchema = z.object({
  title: z.string().trim().min(1, 'Введите название значка').max(BADGE_TITLE_MAX, `Название — до ${BADGE_TITLE_MAX} символов`),
});

/** выдать значок человеку; null — снять */
export const adminUserBadgeSchema = z.object({ badgeId: z.number().int().positive().nullable() });

export const adminTagSchema = z.object({
  text: z.string().trim().min(1, 'Введите текст подписи').max(TAG_TEXT_MAX, `Подпись — до ${TAG_TEXT_MAX} символов`),
  color: z.string().regex(TAG_COLOR_RE, 'Цвет: #rrggbb'),
});

/** награда степени 1 (лучшая) … 8; без даты — сегодняшняя */
export const adminAwardSchema = z.object({
  degree: z
    .number()
    .int()
    .min(AWARD_DEGREE_MIN, 'Степень — от 1 до 8')
    .max(AWARD_DEGREE_MAX, 'Степень — от 1 до 8'),
  caption: z.string().trim().max(AWARD_CAPTION_MAX, `Подпись — до ${AWARD_CAPTION_MAX} символов`).default(''),
  awardedAt: z.number().int().positive().optional(),
});

export const adminUploadsFilterSchema = z.object({
  kind: z.enum(['photo', 'video', 'file', 'voice', 'round']).optional(),
  q: z.string().max(100).optional(),
  chatId: z.number().int().positive().optional(),
  usage: z.enum(['attached', 'avatar', 'sticker', 'unused']).optional(),
});

/** Delete the listed files, or everything the filter finds (`all`). */
export const adminUploadsDeleteSchema = z
  .object({
    ids: z.array(z.string().max(64)).max(1000).optional(),
    all: z.boolean().optional(),
    filter: adminUploadsFilterSchema.optional(),
  })
  .refine((v) => (v.ids && v.ids.length > 0) || v.all, 'Nothing to delete');

/** Admin panel → «Игры»: set fields of one player's save of one game (field id → a number, or [mantissa, exponent] for the clicker's big ones). */
export const adminGameSaveSchema = z.object({
  userId: z.number().int().positive(),
  game: z.string().min(1).max(32),
  values: z
    .record(z.union([z.number().finite(), z.tuple([z.number().finite(), z.number().finite()])]))
    .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 40, 'Nothing to change'),
});

/** Take all of one player's progress in one game back to the start. */
export const adminGameResetSchema = z.object({
  userId: z.number().int().positive(),
  game: z.string().min(1).max(32),
});

/** A press of a button under a bot's message: the data of the button (callback_data) */
export const botCallbackSchema = z.object({
  data: z.string().min(1).max(BOT_CALLBACK_DATA_MAX * 4),
});
