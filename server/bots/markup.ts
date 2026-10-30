import type { ChatKeyboardDTO, InlineButtonDTO, InlineKeyboardDTO } from '@timba/shared';
import { BOT_BUTTONS_MAX, BOT_BUTTON_TEXT_MAX, BOT_CALLBACK_DATA_MAX } from '@timba/shared';
import { badReq } from './errors.js';

/**
 * `reply_markup` of the Bot API: an inline keyboard under the message (InlineKeyboardMarkup),
 * a keyboard under the input field (ReplyKeyboardMarkup), its removal (ReplyKeyboardRemove)
 * or a request to answer the message (ForceReply).
 */

/** A keyboard under the input field, as stored in chat_keyboards. */
export type ChatKeyboardPayload = Omit<ChatKeyboardDTO, 'messageId' | 'botId'>;

export type ParsedMarkup =
  | { kind: 'inline'; keyboard: InlineKeyboardDTO }
  | { kind: 'keyboard'; keyboard: ChatKeyboardPayload }
  | { kind: 'force_reply'; keyboard: ChatKeyboardPayload }
  | { kind: 'remove' };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Telegram counts the data in bytes. */
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function inlineButton(raw: unknown): InlineButtonDTO {
  if (!isObj(raw)) throw badReq('can\'t parse inline keyboard button: object expected');
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) throw badReq('can\'t parse inline keyboard button: Text buttons are unallowed in the inline keyboard');
  if (text.length > BOT_BUTTON_TEXT_MAX) throw badReq('button text is too long');
  const out: InlineButtonDTO = { text };
  let kinds = 0;
  if (raw.callback_data !== undefined) {
    const data = String(raw.callback_data);
    if (!data || bytes(data) > BOT_CALLBACK_DATA_MAX) throw badReq('BUTTON_DATA_INVALID');
    out.callbackData = data;
    kinds++;
  }
  if (raw.url !== undefined) {
    const url = String(raw.url);
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000) throw badReq('wrong HTTP URL specified in the button');
    out.url = url;
    kinds++;
  }
  if (isObj(raw.web_app) && typeof raw.web_app.url === 'string') {
    // there are no mini apps here: the button simply opens the address
    if (!/^https?:\/\/[^\s]+$/i.test(raw.web_app.url)) throw badReq('wrong HTTP URL specified in the button');
    out.url = raw.web_app.url;
    kinds++;
  }
  if (isObj(raw.copy_text)) {
    const copy = String(raw.copy_text.text ?? '');
    if (!copy || copy.length > 256) throw badReq('BUTTON_COPY_TEXT_INVALID');
    out.copyText = copy;
    kinds++;
  }
  if (kinds !== 1) throw badReq('can\'t parse inline keyboard button: exactly one of callback_data, url, web_app or copy_text must be set');
  return out;
}

function parseInline(raw: unknown): InlineKeyboardDTO {
  if (!Array.isArray(raw)) throw badReq('can\'t parse reply keyboard markup JSON object');
  let total = 0;
  const rows = raw
    .filter((row) => !(Array.isArray(row) && row.length === 0))
    .map((row) => {
      if (!Array.isArray(row)) throw badReq('can\'t parse inline keyboard button: InlineKeyboardButton must be an Object');
      if (row.length > 8) throw badReq('too many buttons in a row: at most 8');
      return row.map((b) => {
        total++;
        return inlineButton(b);
      });
    });
  if (total > BOT_BUTTONS_MAX) throw badReq(`too many buttons: at most ${BOT_BUTTONS_MAX}`);
  return { rows };
}

function parseKeyboard(m: Record<string, unknown>): ChatKeyboardPayload {
  const raw = m.keyboard;
  if (!Array.isArray(raw)) throw badReq('can\'t parse reply keyboard markup JSON object');
  let total = 0;
  const rows = raw
    .filter((row) => !(Array.isArray(row) && row.length === 0))
    .map((row) => {
      if (!Array.isArray(row)) throw badReq('can\'t parse keyboard button: array of buttons expected');
      return row.map((b) => {
        total++;
        const text = typeof b === 'string' ? b : isObj(b) && typeof b.text === 'string' ? b.text : '';
        if (!text.trim()) throw badReq('can\'t parse keyboard button: text must be non-empty');
        return text.trim().slice(0, BOT_BUTTON_TEXT_MAX);
      });
    });
  if (total > BOT_BUTTONS_MAX) throw badReq(`too many buttons: at most ${BOT_BUTTONS_MAX}`);
  return {
    type: 'keyboard',
    rows,
    resize: m.resize_keyboard === true,
    oneTime: m.one_time_keyboard === true,
    placeholder: typeof m.input_field_placeholder === 'string' ? m.input_field_placeholder.slice(0, 64) : '',
  };
}

/** null = no markup. */
export function parseReplyMarkup(raw: unknown): ParsedMarkup | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let m = raw;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      throw badReq('can\'t parse reply keyboard markup JSON object');
    }
  }
  if (!isObj(m)) throw badReq('object expected as reply markup');
  if ('inline_keyboard' in m) return { kind: 'inline', keyboard: parseInline(m.inline_keyboard) };
  if ('keyboard' in m) return { kind: 'keyboard', keyboard: parseKeyboard(m) };
  if (m.remove_keyboard === true) return { kind: 'remove' };
  if (m.force_reply === true) {
    return {
      kind: 'force_reply',
      keyboard: {
        type: 'force_reply',
        rows: [],
        resize: false,
        oneTime: false,
        placeholder: typeof m.input_field_placeholder === 'string' ? m.input_field_placeholder.slice(0, 64) : '',
      },
    };
  }
  throw badReq('object expected as reply markup');
}

/** The inline keyboard as the Bot API shows it to bots. */
export function inlineToApi(kb: InlineKeyboardDTO) {
  return {
    inline_keyboard: kb.rows.map((row) =>
      row.map((b) => ({
        text: b.text,
        ...(b.callbackData !== undefined ? { callback_data: b.callbackData } : {}),
        ...(b.url !== undefined ? { url: b.url } : {}),
        ...(b.copyText !== undefined ? { copy_text: { text: b.copyText } } : {}),
        ...(b.invoiceId !== undefined ? { pay: true } : {}),
      })),
    ),
  };
}
