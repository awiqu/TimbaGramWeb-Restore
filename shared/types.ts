import type { QuietHours } from './quiet.js';

/** what the person in a chat is doing besides typing a text (shown as «записывает голосовое…») */
export type TypingAction = 'voice' | 'round';

export type Role = 'owner' | 'admin' | 'member';
export type ChatType = 'private' | 'group' | 'channel';
export type FileKind = 'photo' | 'video' | 'file' | 'voice' | 'round';
export type MessageKind = 'text' | 'media' | 'service' | 'poll' | 'transfer' | 'fund' | 'checklist' | 'sticker';

export interface UserDTO {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  bio: string;
  avatarFileId: string | null;
  lastSeenAt: number | null;
  online: boolean;
  /** set when the user hides their last seen time */
  lastSeenApprox: LastSeenApprox | null;
  /** TimbaGram Premium is active: the badge next to the name */
  premium: boolean;
  /** the admin's special badge: a small picture left of the name; null = none */
  badge: BadgeDTO | null;
  /** a bot (made in the settings): the «БОТ» label instead of last seen, no calls and no ТК */
  isBot?: boolean;
}

/** A special badge the admin made: the picture is /api/badges/<id>/image?v=<v> (about 1em high next to a name) */
export interface BadgeDTO {
  id: number;
  title: string;
  /** changes with the picture, so a new one is not served from the cache */
  v: number;
}

/** A coloured caption right under the name in the profile ("Скам" in red); set by the admin */
export interface UserTagDTO {
  id: number;
  text: string;
  /** "#rrggbb" */
  color: string;
}

/** An award from the administration: degree 1 (the best) … 8, an optional caption and the date */
export interface AwardDTO {
  id: number;
  degree: number;
  caption: string;
  /** ms */
  awardedAt: number;
}

/** What the profile shows besides the name: captions under it and awards */
export interface ProfileExtras {
  tags: UserTagDTO[];
  awards: AwardDTO[];
}

export interface UserProfileDTO extends UserDTO, ProfileExtras {
  /** the viewer blocked this user */
  blockedByMe: boolean;
  /** the viewer has this user in "Контакты" */
  isContact: boolean;
  /** "+79211234567"; null when there is none or the owner hides it */
  phone: string | null;
}

export type LastSeenApprox = 'recently' | 'week' | 'month' | 'long';
export type PrivacyValue = 'everybody' | 'nobody';

export interface Privacy {
  lastSeen: PrivacyValue;
  avatar: PrivacyValue;
  groupInvites: PrivacyValue;
  /** who sees the phone number in the profile */
  phone: PrivacyValue;
}

export interface MeDTO extends UserDTO, ProfileExtras {
  isAdmin: boolean;
  /** set while the global admin is signed in as this user */
  impersonator: string | null;
  prefs: Prefs;
  privacy: Privacy;
  phone: string | null;
  /** when TimbaGram Premium ends; null = never had it or it is over */
  premiumUntil: number | null;
  /** a premium payment waits for the admin's check */
  premiumPending: boolean;
  /** when the weekly premium bonus can be taken (0 or past = now); null without premium */
  premiumBonusAt: number | null;
}

/** One of the accounts signed in on this browser (the account switcher). */
export interface AccountDTO extends UserDTO {
  current: boolean;
  /** unread messages in chats with notifications on */
  unread: number;
}

export interface Prefs {
  theme?: 'light' | 'dark' | 'system';
  /** id of a ready-made theme (accent color + chat background) */
  colorTheme?: string;
  /** legacy: accent color and chat background picked separately, mapped to the closest theme */
  accent?: string;
  wallpaper?: string;
  fontSize?: number;
  /** in-app sound for new messages */
  notifySound?: boolean;
  /** the reaction a double tap puts on a message (one of REACTIONS) */
  quickReaction?: string;
  /** push and sound without a ring at night */
  quietHours?: QuietHours;
}

export interface FileDTO {
  id: string;
  kind: FileKind;
  mime: string;
  size: number;
  name: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  hasThumb: boolean;
  /** voice messages: WAVEFORM_BARS levels 0..31 */
  waveform: number[] | null;
  /** voice and round messages: the text, once somebody asked for it */
  transcript?: string | null;
}

export interface ReplyPreview {
  id: number;
  senderId: number | null;
  senderName: string;
  text: string;
  kind: MessageKind;
  deleted: boolean;
  /** the first photo or video of the answered message, for a small picture in the quote */
  thumb?: { fileId: string; hasThumb: boolean } | null;
}

export interface PollOptionDTO {
  text: string;
  voters: number;
}

/** The card under a message with a link: what the page says about itself. The picture is a copy kept by the server. */
export interface LinkPreviewDTO {
  /** the address that was opened */
  url: string;
  siteName: string;
  title: string;
  description: string;
  /** /api/link-preview/image/<id> */
  image: { id: string; width: number; height: number } | null;
}

export interface PollDTO {
  id: number;
  question: string;
  options: PollOptionDTO[];
  totalVoters: number;
  anonymous: boolean;
  multiple: boolean;
  quiz: boolean;
  closed: boolean;
  /** ms timestamp when the poll closes automatically */
  closeAt: number | null;
  /** quiz only: known once the viewer voted or the poll is closed */
  correctOption?: number | null;
  explanation?: string;
  /** options the viewer voted for; absent in broadcasts that are not addressed to the viewer */
  myVotes?: number[];
}

export interface ReactionDTO {
  emoji: string;
  count: number;
  /** the viewer's own reaction; absent in broadcasts */
  mine?: boolean;
  /** last people who reacted (empty in channels) */
  recent: UserDTO[];
}

export interface ReactionsEvent {
  chatId: number;
  messageId: number;
  reactions: ReactionDTO[];
  userId: number;
  emoji: string | null;
}

export interface ReactorDTO {
  user: UserDTO;
  emoji: string;
}

export interface ReaderDTO {
  user: UserDTO;
  readAt: number;
}

export interface PollVotersDTO {
  option: number;
  users: UserDTO[];
}

export interface MessageDTO {
  id: number;
  chatId: number;
  /** In channels the author is hidden (null) for everybody except the author themself */
  senderId: number | null;
  sender: UserDTO | null;
  kind: MessageKind;
  text: string;
  replyTo: ReplyPreview | null;
  forwardedFrom: { id: number | null; name: string } | null;
  attachments: FileDTO[];
  poll: PollDTO | null;
  /** channel posts: author name when signatures are on */
  signature: string | null;
  /** channel posts: view count */
  views: number | null;
  reactions: ReactionDTO[];
  /** comments: id of the channel post */
  threadId: number | null;
  /** channel posts with comments enabled */
  commentCount: number | null;
  commenters: UserDTO[];
  editedAt: number | null;
  createdAt: number;
  clientId?: string;
  /** sent without sound */
  silent?: boolean;
  /** auto-delete: disappears at this time (ms) */
  expiresAt?: number | null;
  /** kind "transfer": ТК sent right in the chat */
  transfer?: ChatTransferDTO;
  /** kind "fund": a fundraiser ("Скинуться") */
  fund?: FundDTO;
  /** kind "checklist" */
  checklist?: ChecklistDTO;
  /** kind "sticker"; the text holds its emoji */
  sticker?: StickerDTO;
  /** a bot's buttons under the message */
  replyMarkup?: InlineKeyboardDTO;
}

/** One button of a bot's keyboard under a message: a callback, a link or a text to copy. */
export interface InlineButtonDTO {
  text: string;
  /** a press goes to the bot as a callback query with this data */
  callbackData?: string;
  /** a press opens this address (the app asks first, like for any link) */
  url?: string;
  /** a press copies this text */
  copyText?: string;
  /** «Оплатить»: a press opens the payment of this invoice (only the server puts it there, for sendInvoice) */
  invoiceId?: number;
}

export interface InlineKeyboardDTO {
  rows: InlineButtonDTO[][];
}

/**
 * The keyboard a bot put under the input field (ReplyKeyboardMarkup), or a request to answer its message (ForceReply).
 * It belongs to the chat: the latest one stays until the bot removes it.
 */
export interface ChatKeyboardDTO {
  type: 'keyboard' | 'force_reply';
  rows: string[][];
  /** the keyboard is smaller than the system one */
  resize: boolean;
  /** hide after the first press */
  oneTime: boolean;
  /** grey text in the empty input field */
  placeholder: string;
  /** the bot's message the keyboard came with (force_reply: answered with a reply to it) */
  messageId: number;
  botId: number;
}

export interface BotCommandDTO {
  command: string;
  description: string;
}

/** What a bot looks like in its profile and in the «Меню» of the chat. */
export interface BotInfoDTO {
  userId: number;
  /** «Что умеет этот бот?» — shown in an empty chat */
  description: string;
  /** the short «О боте» line */
  about: string;
  commands: BotCommandDTO[];
  /** may be added to groups */
  canJoinGroups: boolean;
  /** in groups the bot sees only commands, replies and mentions */
  privacyMode: boolean;
  /** @PremiumBot and @WeatherBot run inside the server */
  builtin: boolean;
}

/** The tills of bots: whose money a bot's payments move. */
export type BotWallet = 'bot' | 'owner';

export type InvoiceStatus = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'expired';

/** A bot's invoice in ТК (the Bot API's sendInvoice). The payer sees it as a message with a button «Оплатить». */
export interface InvoiceDTO {
  id: number;
  bot: UserDTO;
  title: string;
  description: string;
  amount: number;
  status: InvoiceStatus;
  createdAt: number;
  expiresAt: number | null;
  paidAt: number | null;
}

export interface InvoicePayResult {
  invoice: InvoiceDTO;
  balance: number;
}

/** A bot as its owner (or the admin) sees it in the bot manager. */
export interface MyBotDTO {
  user: UserDTO;
  owner: UserDTO | null;
  builtin: string | null;
  description: string;
  about: string;
  commands: BotCommandDTO[];
  canJoinGroups: boolean;
  privacyMode: boolean;
  wallet: BotWallet;
  /** what is in the till: the bot's own account or the owner's balance; -1 never runs out */
  walletBalance: number;
  /** the bot's own account */
  ownBalance: number;
  paidInvoices: number;
  earned: number;
  /** switched off by the admin */
  paymentsEnabled: boolean;
  disabled: boolean;
  createdAt: number;
}

/** The page of one bot: the token is shown only here, to the owner and the admin. */
export interface MyBotDetailDTO extends MyBotDTO {
  token: string | null;
  webhook: boolean;
  /** updates waiting for the bot */
  pending: number;
}

export interface MyBotsDTO {
  bots: MyBotDTO[];
  /** ТК a new bot costs */
  price: number;
  max: number;
  createEnabled: boolean;
}

export type BotUsernameCheck = 'ok' | 'invalid' | 'not_bot' | 'taken';

export interface BotLedgerItem {
  id: number;
  type: 'payment' | 'refund' | 'payout' | 'withdraw' | 'deposit';
  /** + in, − out */
  amount: number;
  createdAt: number;
  user: UserDTO | null;
  message: string;
}

/** What admin sets for every bot (admin panel → Боты). */
export interface BotSettingsDTO {
  /** people may create bots */
  createEnabled: boolean;
  maxPerUser: number;
  /** invoices and payouts of bots work at all */
  paymentsEnabled: boolean;
  /** the share of every paid invoice that goes to the cash (@admin), percent */
  feePercent: number;
  maxInvoice: number;
  /** an invoice without its own term is valid this long */
  invoiceTtlHours: number;
}

/** A bot's till as the owner sees it. */
export interface BotWalletInfo {
  wallet: BotWallet;
  /** -1: the account never runs out */
  balance: number;
  /** the bot's own account (the owner's balance is not counted) */
  ownBalance: number;
}

/** The bot's answer to a button press (answerCallbackQuery): a small toast, an alert or a link. */
export interface BotCallbackAnswer {
  id: string;
  text?: string;
  alert?: boolean;
  url?: string;
}

/** A bot in the admin panel */
export interface AdminBotDTO {
  user: UserDTO;
  owner: UserDTO | null;
  builtin: string | null;
  commands: number;
  canJoinGroups: boolean;
  createdAt: number;
  /** updates waiting for the bot to pick them up */
  pending: number;
  webhook: boolean;
  /** frozen by the admin: the token does not work, the bot hears nothing */
  disabled: boolean;
  /** the admin allows this bot invoices and payouts */
  paymentsEnabled: boolean;
  wallet: BotWallet;
  /** the bot's own account */
  ownBalance: number;
  /** paid invoices and the coins they brought, over the bot's life */
  paidInvoices: number;
  earned: number;
}

/**
 * A sticker: one of the built-in TimbaGram smileys (id "tg:<key>", drawn by the client)
 * or a picture from a user's pack (id = its number as a string, fileId = the square image).
 */
export interface StickerDTO {
  id: string;
  /** custom stickers: the image; null for the built-in ones */
  fileId: string | null;
  emoji: string;
  /** the pack it came from; null for the built-in pack or when the pack is gone */
  packId: number | null;
}

export interface StickerPackDTO {
  id: number;
  title: string;
  /** the address part of the share link: /addstickers/<token> */
  token: string;
  owner: UserDTO | null;
  /** the viewer made this pack and may edit it */
  mine: boolean;
  /** the pack is in the viewer's sticker panel */
  added: boolean;
  stickers: StickerDTO[];
}

/** The sticker panel: the viewer's own and added packs, in the order they were added. */
export interface StickerPacksDTO {
  packs: StickerPackDTO[];
  /** how many packs the viewer made (Премиум: up to MAX_STICKER_PACKS) */
  ownCount: number;
}

export interface ChatTransferDTO {
  amount: number;
  from: UserDTO | null;
  to: UserDTO | null;
}

export interface FundDTO {
  id: number;
  title: string;
  /** null = no target */
  goal: number | null;
  collected: number;
  contributors: number;
  closed: boolean;
  creatorId: number | null;
  /** the last people who chipped in */
  recent: { user: UserDTO; amount: number }[];
}

export interface ChecklistItemDTO {
  id: number;
  text: string;
  doneBy: UserDTO | null;
  doneAt: number | null;
}

export interface ChecklistDTO {
  id: number;
  title: string;
  creatorId: number | null;
  othersCanAdd: boolean;
  items: ChecklistItemDTO[];
}

export interface ScheduledMessageDTO {
  id: number;
  chatId: number;
  text: string;
  replyToId: number | null;
  attachments: FileDTO[];
  silent: boolean;
  sendAt: number;
  createdAt: number;
}

export interface AdminRights {
  changeInfo: boolean;
  deleteMessages: boolean;
  banUsers: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
  addAdmins: boolean;
  /** channels: publish posts */
  postMessages: boolean;
  /** channels: edit posts of other admins */
  editMessages: boolean;
}

export interface GroupPermissions {
  sendMessages: boolean;
  sendMedia: boolean;
  sendPolls: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
}

export interface MyMembership {
  isMember: boolean;
  role: Role | null;
  rights: AdminRights;
  mutedUntil: number | null;
  canSend: boolean;
  canSendMedia: boolean;
  canSendPolls: boolean;
  canInvite: boolean;
  canPin: boolean;
  /** channels: may see the subscriber list */
  canSeeMembers: boolean;
  isBanned: boolean;
  /** notifications for this chat are switched off */
  notificationsMuted: boolean;
  /** ...until this time (ms); null when off for good or not off */
  notificationsMutedUntil: number | null;
  /** slow mode: the viewer may write again at this time (ms) */
  slowModeUntil: number | null;
}

export interface ChatDTO {
  id: number;
  type: ChatType;
  title: string;
  description: string;
  avatarFileId: string | null;
  isPublic: boolean;
  publicUsername: string | null;
  inviteToken: string | null;
  ownerId: number | null;
  memberCount: number;
  onlineCount: number;
  peer: UserDTO | null;
  lastMessage: MessageDTO | null;
  unreadCount: number;
  lastReadId: number;
  othersReadId: number;
  pinned: MessageDTO[];
  defaultPermissions: GroupPermissions;
  /** channels: show the author's name under posts */
  signMessages: boolean;
  reactionsEnabled: boolean;
  /** channels: comments under posts */
  commentsEnabled: boolean;
  /** personal: pinned in the chat list */
  pinnedAt: number | null;
  archived: boolean;
  /** the viewer marked the chat as unread by hand (a dot in the list until they open it) */
  markedUnread: boolean;
  /** ids of unread messages that mention the viewer or reply to them */
  unreadMentions: number[];
  /** private chats: the viewer blocked the peer */
  peerBlocked: boolean;
  /** new messages disappear after this many seconds; null = off */
  autoDelete: number | null;
  /** public groups and channels: joining needs an admin's approval */
  joinApproval: boolean;
  /** the viewer asked to join and waits for an admin */
  joinRequested: boolean;
  /** admins who may invite: requests waiting for an answer */
  pendingRequests: number;
  /** groups: members may send one message per this many seconds; 0 = off */
  slowMode: number;
  /** channels: subscribers added by the admin, included in memberCount; only the admin sees it, 0 for others */
  boostSubscribers: number;
  /** the viewer's scheduled messages waiting in this chat */
  scheduledCount: number;
  /** the keyboard a bot showed under the input field */
  keyboard?: ChatKeyboardDTO | null;
  me: MyMembership;
  createdAt: number;
  lastActivityAt: number;
}

export interface MemberDTO {
  user: UserDTO;
  role: Role;
  rights: AdminRights;
  customTitle: string;
  mutedUntil: number | null;
  joinedAt: number;
}

export interface BanDTO {
  user: UserDTO;
  bannedBy: number | null;
  until: number | null;
  createdAt: number;
}

export interface SessionDTO {
  id: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
  /** the global admin signed in as the user (admin view only) */
  impersonated?: boolean;
}

export interface AppStatus {
  maintenance: boolean;
  maintenanceMessage: string;
  registrationOpen: boolean;
  maxUploadMb: number;
  /** displayed name of the messenger */
  appName: string;
  /** current version; clients that loaded an older one are offered a reload */
  version: string;
  /** bumped by the admin to make every open client reload */
  buildId: number;
  /** 0 = the built-in logo, otherwise a cache key for the uploaded one (/api/logo?v=…) */
  logoVersion: number;
  /** banner shown to everybody, empty = none */
  announcement: string;
  groupCreation: boolean;
  channelCreation: boolean;
  uploadsEnabled: boolean;
  /** «Поддержать проект» link; empty = no button */
  donateUrl: string;
  /** top-up payment page; empty = pay by the phone number */
  topupUrl: string;
  /** TimbaGram Premium: the payment page ("Оплатить"); empty = pay by the phone number */
  premiumUrl: string;
  /** ₽ a month */
  premiumPrice: number;
  /** automatic answers in support tickets */
  supportBot: boolean;
  /** bumped when the admin changes interface texts (/api/app/labels) */
  labelsVersion: number;
  /** https address of the site (PUBLIC_URL), if configured */
  publicUrl: string | null;
  /** voice messages can be turned into text */
  transcription: boolean;
}

export interface AdminStats {
  users: number;
  bannedUsers: number;
  groups: number;
  channels: number;
  privateChats: number;
  messages: number;
  files: number;
  filesBytes: number;
  online: number;
  sessions: number;
  newUsersWeek: number;
  messagesDay: number;
  /** messages per day, oldest first, last 14 days */
  messagesByDay: { day: string; count: number }[];
  /** users who wrote the most in the last 7 days */
  topSenders: { user: UserDTO; count: number }[];
}

export interface AdminUserDTO extends UserDTO {
  isBanned: boolean;
  banReason: string;
  createdAt: number;
  premiumUntil: number | null;
}

/** a Премиум promo code in the admin panel */
export interface PremiumPromoDTO {
  id: number;
  code: string;
  /** null = premium without an end */
  days: number | null;
  /** null = no limit */
  maxUses: number | null;
  uses: number;
  /** after this moment the code no longer works; null = never */
  expiresAt: number | null;
  createdAt: number;
}

/** a device (browser) an account was used on; the id is a cookie, see server/src/devices.ts */
export interface AdminDeviceDTO {
  id: string;
  userAgent: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  banned: boolean;
  banReason: string;
  /** other accounts used on the same device */
  otherUsers: { id: number; username: string }[];
}

export interface BannedDeviceDTO {
  id: string;
  reason: string;
  bannedAt: number;
  /** the account the device was banned through; null if it was deleted since */
  userId: number | null;
  username: string;
}

/** a badge in the admin's catalog */
export interface AdminBadgeDTO extends BadgeDTO {
  /** users who wear it */
  holders: number;
  createdAt: number;
}

export interface AdminUserDetail extends AdminUserDTO, ProfileExtras {
  /** real values, without privacy applied */
  realLastSeenAt: number | null;
  isAdmin: boolean;
  messageCount: number;
  chatCount: number;
  ownedGroups: number;
  sessions: SessionDTO[];
  devices: AdminDeviceDTO[];
}

export interface AdminChatDTO {
  id: number;
  /** one member for "saved messages", two otherwise */
  members: UserDTO[];
  messageCount: number;
  lastMessage: MessageDTO | null;
  lastActivityAt: number;
}

export interface AdminGroupDTO {
  id: number;
  type: ChatType;
  title: string;
  avatarFileId: string | null;
  isPublic: boolean;
  publicUsername: string | null;
  /** real members plus boostSubscribers */
  memberCount: number;
  boostSubscribers: number;
  messageCount: number;
  owner: UserDTO | null;
  createdAt: number;
}

export interface SearchResult {
  users: UserDTO[];
  groups: ChatDTO[];
}

/** What a phone-book import found. Numbers of people who are not here are not kept anywhere. */
export interface ImportContactsResult {
  /** people from the request who are in the messenger (new contacts and the ones that were already) */
  found: number;
  /** people from the request */
  total: number;
  /** the ones that became contacts just now */
  added: UserDTO[];
}

export interface FolderFilters {
  private: boolean;
  groups: boolean;
  channels: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
}

export interface FolderDTO {
  id: number;
  title: string;
  filters: FolderFilters;
  includeIds: number[];
  excludeIds: number[];
}

export interface MessageSearchResult {
  messages: MessageDTO[];
  /** more results before the last one */
  hasMore: boolean;
}

export interface InvitePreview {
  id: number;
  type: ChatType;
  title: string;
  description: string;
  avatarFileId: string | null;
  memberCount: number;
  isMember: boolean;
  /** joining by this link needs an admin's approval */
  approval: boolean;
  /** the viewer already sent a request */
  requested: boolean;
}

/** Answer of joining by a link or a public chat's button: either the chat, or a request was sent */
export type JoinResult = ChatDTO | { requested: true };

/** An extra invite link of a group or channel */
export interface InviteLinkDTO {
  token: string;
  title: string;
  expiresAt: number | null;
  usageLimit: number | null;
  uses: number;
  approval: boolean;
  revoked: boolean;
  /** expired, used up or revoked */
  active: boolean;
  /** requests that came by this link and wait for an answer */
  requests: number;
  creator: UserDTO | null;
  createdAt: number;
}

export interface JoinRequestDTO {
  user: UserDTO;
  /** the link's title, or its token when it has none; null = the public chat's button */
  via: string | null;
  createdAt: number;
}

export interface StatsDay {
  /** start of the day (in the viewer's time zone), ms */
  day: number;
  members: number;
  joins: number;
  leaves: number;
  /** groups: messages that day; channels: posts */
  messages: number;
}

export interface StatsPost {
  message: MessageDTO;
  views: number;
  reactions: number;
  shares: number;
  comments: number;
}

export interface ChatStatsDTO {
  type: ChatType;
  members: number;
  /** change over the last 7 days, and the 7 days before them */
  growth7: number;
  growthPrev7: number;
  joins30: number;
  leaves30: number;
  messages30: number;
  days: StatsDay[];
  /** channels: the latest posts */
  posts: StatsPost[];
  avgViews: number;
  avgShares: number;
  avgReactions: number;
  /** groups: the most active members over 30 days */
  topMembers: { user: UserDTO; messages: number }[];
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  chatId: number;
  url: string;
  tag: string;
  /** sent without sound */
  silent?: boolean;
}

/** Audio/video calls: the media goes browser to browser (WebRTC), the server only relays signals. */
export interface CallIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CallIncomingEvent {
  callId: string;
  from: UserDTO;
  video: boolean;
  iceServers: CallIceServer[];
}

export type CallStartResult = { ok: true; callId: string; iceServers: CallIceServer[] } | { ok: false; error: string };

export type CallEndReason = 'ended' | 'declined' | 'missed' | 'busy' | 'answered_elsewhere' | 'failed';

export interface CallEndEvent {
  callId: string;
  reason: CallEndReason;
}

/** relayed as is between the two sides: SDP, ICE candidates, camera/mic state */
export type CallSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } }
  | { type: 'media'; audio: boolean; video: boolean; screen?: boolean };

/** Group calls (in a group chat or by a link): a mesh of one-to-one connections. */
export interface GroupCallParticipant {
  /** the participant's socket: one user may have one tab in the call */
  peerId: string;
  user: UserDTO;
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export interface GroupCallInfo {
  key: string;
  chatId: number | null;
  title: string;
  startedAt: number;
  count: number;
  userIds: number[];
}

export type GroupCallJoinResult =
  | {
      ok: true;
      key: string;
      chatId: number | null;
      title: string;
      startedAt: number;
      selfPeerId: string;
      participants: GroupCallParticipant[];
      iceServers: CallIceServer[];
    }
  | { ok: false; error: string };

/** answered; missed = incoming nobody took; cancelled = the caller hung up first; noanswer / busy / declined */
export type CallLogStatus = 'answered' | 'missed' | 'cancelled' | 'declined' | 'noanswer' | 'busy';

export interface CallLogEntry {
  id: number;
  kind: 'private' | 'group';
  peer: UserDTO | null;
  /** group calls: the group, or the link */
  chatId: number | null;
  linkToken: string | null;
  title: string;
  outgoing: boolean;
  video: boolean;
  status: CallLogStatus;
  startedAt: number;
  /** seconds */
  duration: number;
}

export interface CallLinkDTO {
  token: string;
  title: string;
  url: string;
  creator: UserDTO | null;
  /** people in the call right now */
  count: number;
}

export type TicketType = 'problem' | 'question' | 'payment' | 'suggestion' | 'complaint' | 'other';
/**
 * open: support answers; operator: waiting for a person (support stays quiet); answered: the person has replied and
 * the ticket waits for the user (support stays quiet; the user writing again puts it back to "operator"); closed
 */
export type TicketStatus = 'open' | 'operator' | 'answered' | 'closed';

export interface TicketMessageDTO {
  id: number;
  ticketId: number;
  /** support = the support team's automatic answers, operator = the admin, system = status notes */
  author: 'user' | 'support' | 'operator' | 'system';
  text: string;
  createdAt: number;
}

export interface TicketDTO {
  id: number;
  type: TicketType;
  subject: string;
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
  /** new answers the viewer has not seen */
  unread: number;
  lastMessage: TicketMessageDTO | null;
  /** the admin's view only */
  user?: UserDTO;
  /** support is writing an answer */
  typing?: boolean;
}

export interface TicketDetailDTO extends TicketDTO {
  messages: TicketMessageDTO[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
  [k: string]: unknown;
}

// ---------- PupsoBank ----------

export interface BankInfo {
  balance: number;
  banned: boolean;
  jokePrice: number;
}

export type BankOpKind =
  | 'start'
  | 'topup'
  | 'transfer_in'
  | 'transfer_out'
  | 'joke'
  | 'ai'
  | 'promo'
  | 'admin'
  /** the cash (@admin): fees for jokes and УмныйТим */
  | 'income'
  /** the cash (@admin): a promo code paid out */
  | 'promo_payout'
  /** a round in the Казино: the win minus the bet */
  | 'casino'
  /** a multiplayer game on ТК (duel, dice): the stake or the win */
  | 'pvp'
  /** creating a bot */
  | 'bot'
  /** the weekly bonus of TimbaGram Premium */
  | 'premium_bonus'
  /** a prize for a place in the monthly rating of the games */
  | 'rating_prize'
  /** paid a bot's invoice */
  | 'invoice_pay'
  /** a bot's till (or its owner) received the payment of an invoice */
  | 'invoice_in'
  /** an invoice was refunded: the money came back / went back */
  | 'refund_in'
  | 'refund_out'
  /** a bot paid coins to a user */
  | 'payout_in'
  | 'payout_out';

export type RouletteBet =
  | { type: 'number'; value: number; amount: number }
  | { type: 'dozen'; value: 1 | 2 | 3; amount: number }
  | { type: 'red' | 'black' | 'even' | 'odd' | 'low' | 'high'; amount: number };

export interface CasinoResult {
  /** paid back, bet included (0 = lost) */
  win: number;
  balance: number;
  /** slots: symbol indexes of the three reels */
  reels?: number[];
  /** roulette: 0…36 */
  number?: number;
}

export interface BankOperation {
  id: number;
  kind: BankOpKind;
  amount: number;
  /** transfers and cash operations: the other side's username; promo: the code */
  peer: string | null;
  message: string;
  createdAt: number;
}

export interface BankHistory {
  items: BankOperation[];
  hasMore: boolean;
}

export interface BankTransferResult {
  balance: number;
}

export interface BankJoke {
  joke: string;
  balance: number;
}

export type TopupStatus = 'pending' | 'approved' | 'rejected';

/** coins = ТимбаКоины top-up, premium = a month of TimbaGram Premium */
export type TopupKind = 'coins' | 'premium';

export interface TopupDTO {
  id: number;
  kind: TopupKind;
  amount: number;
  status: TopupStatus;
  user: UserDTO | null;
  createdAt: number;
}

/** bank = ТимбаКоины and Премиум; support = for the admin: tickets and payment checks */
export type NotificationKind = 'bank' | 'support';

export interface NotificationDTO {
  id: number;
  kind: NotificationKind;
  text: string;
  createdAt: number;
  read: boolean;
  /** a payment check for the admin: the buttons "Подтвердить" / "Отклонить" */
  topup?: TopupDTO;
}

export type NotificationUnread = Record<NotificationKind, number>;

/** socket EV.notification: a new or changed notification and/or fresh unread counters */
export interface NotificationEvent {
  notification?: NotificationDTO;
  unread?: NotificationUnread;
}

export interface BankSettings {
  startBalance: number;
  jokePrice: number;
  /** ТК for creating a bot (not returned when it is deleted) */
  botPrice: number;
}

export interface AdminBankAccount {
  user: UserDTO;
  /** -1 = infinite */
  balance: number;
  banned: boolean;
  createdAt: number;
}

export interface AdminBankPromo {
  code: string;
  tcoins: number;
  maxUses: number | null;
  used: number;
  active: boolean;
  createdAt: number;
}

export interface AdminBankOp extends BankOperation {
  user: UserDTO | null;
}

export interface AdminBankOverview {
  /** all the coins on accounts (infinite ones not counted) */
  totalBalance: number;
  accountCount: number;
  opsToday: number;
  settings: BankSettings;
  accounts: AdminBankAccount[];
  promos: AdminBankPromo[];
}

// ---------- multiplayer games on ТК ----------

export type PvpGame = 'duel' | 'dice' | 'tictactoe' | 'connect4' | 'rps' | 'nim';
/** pending: the invite waits for an answer; active: both stakes are held; the rest are over */
export type PvpStatus = 'pending' | 'active' | 'finished' | 'declined' | 'cancelled' | 'expired';
/** duel: shoot with the current chance, aim (+chance) or knock the other's aim back to the base */
export type DuelAction = 'shoot' | 'aim' | 'knock';

/** mark: a cross or a nought (cell); drop: a disc into a column; pick: rock, scissors or paper; add: a number to the counter */
export type PvpAction = DuelAction | 'roll' | 'mark' | 'drop' | 'pick' | 'add';

export interface PvpMove {
  by: number;
  action: PvpAction;
  /** shoot: the chance it had, % */
  chance?: number;
  hit?: boolean;
  /** dice: 1…6 */
  roll?: number;
  /** dice, rock-paper-scissors: the round it was played in (ties are played again) */
  round?: number;
  /** tictactoe: the cell 0…8; connect4: the column 0…6 */
  cell?: number;
  /** nim: what was added, 1…3 */
  n?: number;
  /** rock-paper-scissors: shown when the round is decided, not before */
  pick?: 'rock' | 'scissors' | 'paper';
  /** the server made it because the player ran out of time */
  auto?: boolean;
  at: number;
}

export interface PvpMatchDTO {
  id: number;
  game: PvpGame;
  status: PvpStatus;
  /** each player's stake, ТК; the winner takes both */
  stake: number;
  creator: UserDTO;
  opponent: UserDTO;
  /** duel: whose move it is */
  turn: number | null;
  /** pending: when the invite expires; active: when the move (or dice round) times out */
  deadline: number | null;
  /** duel: every player's chance to hit, % */
  aim: Record<number, number>;
  /** dice: the current round and what was rolled in it so far */
  round: number;
  rolls: Record<number, number>;
  moves: PvpMove[];
  /** tictactoe, connect4: the board, row by row (0 empty, 1 the inviter, 2 the invited) */
  board: number[];
  /** rock-paper-scissors: rounds won by each player */
  wins: Record<number, number>;
  /** rock-paper-scissors: who already chose in this round (what they chose stays secret) */
  picked: number[];
  /** nim: the counter */
  total: number;
  /** a finished game without a winner is a draw: both stakes are given back */
  winnerId: number | null;
  /** the loser gave up or ran out of time */
  forfeit: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One line of a game's monthly top */
export interface LeaderEntryDTO {
  rank: number;
  user: UserDTO;
  score: number;
}

export interface LeaderboardDTO {
  game: string;
  /** the month of the rating, «2026-05» */
  period: string;
  /** when it ends and the rating starts anew, ms */
  endsAt: number;
  entries: LeaderEntryDTO[];
  /** the viewer's own place, also when it is outside the top */
  me: { rank: number; score: number } | null;
  /** who led the game in the month before (and got the award) */
  previous: { period: string; user: UserDTO } | null;
}

/** Admin panel → «Файлы»: one uploaded file with where it is used. */
export interface AdminUploadDTO {
  id: string;
  kind: FileKind;
  mime: string;
  size: number;
  name: string;
  hasThumb: boolean;
  width: number | null;
  height: number | null;
  duration: number | null;
  createdAt: number;
  uploader: { id: number; username: string; name: string } | null;
  /** the chat of the latest message it was sent in; null: it is in no message */
  chat: { id: number; type: ChatType; title: string } | null;
  messageId: number | null;
  /** how many messages show it */
  uses: number;
  isAvatar: boolean;
  /** a sticker file: kept, the stickers would break */
  isSticker: boolean;
}

export interface AdminUploadsPage {
  items: AdminUploadDTO[];
  /** all that fit the filter, not only this page */
  total: number;
  totalBytes: number;
}

export interface AdminUploadsSummary {
  byKind: { kind: FileKind; count: number; bytes: number }[];
  byChat: { chatId: number; type: ChatType; title: string; count: number; bytes: number }[];
  /** in no message, no avatar and no sticker pack */
  unused: { count: number; bytes: number };
}

export type AdminUploadSort = 'date' | 'size' | 'kind' | 'name' | 'chat' | 'uploader';
export type AdminUploadUsage = 'attached' | 'avatar' | 'sticker' | 'unused';

/** Admin panel → «Игры»: one player's save of one game, a row of the list. */
export interface AdminGameSaveDTO {
  user: { id: number; username: string; name: string; avatarFileId: string | null; isBanned: boolean };
  game: string;
  /** the number the game is judged by; null: nothing yet (no record, a fresh save) */
  progress: number | null;
  /** the saved value of every field of the game, by field id (the clicker's big numbers as the game saved them) */
  values: Record<string, unknown>;
  updatedAt: number;
  /** when an admin last changed it; 0: never */
  editedAt: number;
}

export interface AdminGameSavesPage {
  items: AdminGameSaveDTO[];
  /** all that fit the filter, not only this page */
  total: number;
}

export interface AdminGamesSummary {
  /** players with a save of any game */
  players: number;
  games: { game: string; players: number }[];
}

/** an earlier save of the clicker kept by the server */
export interface ClickerBackupDTO {
  id: number;
  savedAt: number;
  resets: number;
  cores: number;
  total: unknown;
  pinned: boolean;
}

export interface AdminGameSaveDetail extends AdminGameSaveDTO {
  /** the clicker's earlier saves, the newest first (other games keep none) */
  backups: ClickerBackupDTO[];
}

export type AdminGameSort = 'updated' | 'progress' | 'name';
/** «with progress» / «without any»; no value: both */
export type AdminGameHas = 'yes' | 'no';
