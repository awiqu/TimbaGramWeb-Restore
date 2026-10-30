import { txt } from './strings.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = txt.errors.unauthorized) => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = txt.errors.forbidden, code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = txt.errors.notFound) => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
