import type { BotRow } from './store.js';

/**
 * @PremiumBot and @WeatherBot run inside the server. They get the very same updates as any bot (see updates.ts)
 * and answer through the Bot API methods (see api.ts) — only the way to the bot is shorter.
 */
export interface BuiltinUpdate {
  update_id: number;
  [kind: string]: unknown;
}

export type BuiltinHandler = (bot: BotRow, update: BuiltinUpdate) => Promise<void> | void;

const handlers = new Map<string, BuiltinHandler>();
const chains = new Map<number, Promise<void>>();

export function registerBuiltin(kind: string, handler: BuiltinHandler) {
  handlers.set(kind, handler);
}

/** Updates of one bot are handled one after another, so a quick second message never races the first. */
export function runBuiltin(bot: BotRow, update: BuiltinUpdate) {
  const handler = bot.builtin ? handlers.get(bot.builtin) : undefined;
  if (!handler) return;
  const prev = chains.get(bot.user_id) ?? Promise.resolve();
  const next = prev
    .then(() => handler(bot, update))
    .catch((e) => console.error(`bot ${bot.builtin}:`, e))
    .finally(() => {
      if (chains.get(bot.user_id) === next) chains.delete(bot.user_id);
    });
  chains.set(bot.user_id, next);
}
