import type { ChatRow } from '../permissions.js';
import type { MessageRow, UserRow } from '../serialize.js';

/**
 * The messenger tells bots about what happens in chats through these hooks. They are empty until
 * bots/updates.ts fills them in at start, so the message services need no import of the bot code
 * (which itself uses those services).
 */
export interface BotHooks {
  /** a message was sent (any kind but "service") */
  newMessage(chat: ChatRow, sender: UserRow, row: MessageRow): void;
  /** the text of a message was changed */
  editedMessage(chat: ChatRow, editor: UserRow, row: MessageRow): void;
  /** somebody voted in a poll (votes = the new choice, empty = retracted) */
  pollAnswer(pollId: number, user: UserRow, votes: number[]): void;
  /** the numbers of a poll changed, or it was closed */
  pollChanged(pollId: number): void;
  /** somebody set, changed or removed a reaction */
  reaction(chat: ChatRow, user: UserRow, row: MessageRow, oldEmoji: string | null, newEmoji: string | null): void;
  /** people joined a group or channel (`actor` added them, or they joined themselves) */
  membersAdded(chat: ChatRow, actor: UserRow, added: UserRow[], serviceMessageId: number | null): void;
  /** somebody left, was removed or banned */
  memberLeft(chat: ChatRow, actor: UserRow, who: UserRow, kicked: boolean, serviceMessageId: number | null): void;
  /** the user blocked or unblocked a bot */
  blocked(user: UserRow, bot: UserRow, blocked: boolean): void;
  /** somebody ticked an item of a checklist or added one */
  checklistChanged(
    checklistId: number,
    user: UserRow,
    change: { done: number[]; undone: number[]; added: number[] },
  ): void;
}

const noop = () => {};

export const botHooks: BotHooks = {
  newMessage: noop,
  editedMessage: noop,
  pollAnswer: noop,
  pollChanged: noop,
  reaction: noop,
  membersAdded: noop,
  memberLeft: noop,
  blocked: noop,
  checklistChanged: noop,
};

export function setBotHooks(h: Partial<BotHooks>) {
  Object.assign(botHooks, h);
}
