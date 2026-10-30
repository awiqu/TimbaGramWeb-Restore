import { HttpError } from '../errors.js';

/** An error of the Bot API: it goes back as `{ok: false, error_code, description}`, like in Telegram. */
export class BotApiError extends Error {
  constructor(
    public code: number,
    public description: string,
    public parameters?: { retry_after?: number },
  ) {
    super(description);
  }
}

export const badReq = (message: string) => new BotApiError(400, `Bad Request: ${message}`);
export const forbiddenReq = (message: string) => new BotApiError(403, `Forbidden: ${message}`);

/** What the messenger's services throw, as the Bot API says it. */
export function fromHttpError(e: HttpError): BotApiError {
  if (e.code === 'blocked_by_user') return forbiddenReq('bot was blocked by the user');
  if (e.code === 'slow_mode') {
    const until = Number(e.extra.until) || Date.now();
    return new BotApiError(429, `Too Many Requests: retry after ${Math.max(1, Math.ceil((until - Date.now()) / 1000))}`, {
      retry_after: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
    });
  }
  if (e.status === 429) return new BotApiError(429, 'Too Many Requests: retry after 1', { retry_after: 1 });
  if (e.status === 403) return forbiddenReq(e.message);
  if (e.status === 401) return new BotApiError(401, 'Unauthorized');
  return badReq(e.message);
}
