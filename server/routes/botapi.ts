import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rateLimit } from '../auth.js';
import { uploadsDir } from '../config.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { callBotMethod } from '../bots/api.js';
import { BotApiError, fromHttpError } from '../bots/errors.js';
import { botCanUse } from '../bots/files.js';
import { type BotRow, getBotByToken } from '../bots/store.js';
import { type PendingUpload, writeUpload } from '../services/files.js';
import { type FileRow, getUserRow } from '../serialize.js';
import { getSettings } from '../settings.js';

/**
 * The Bot API, shaped like Telegram's:
 *   POST|GET /bot<token>/<method>        parameters as JSON, a form, a query string or multipart (files)
 *   GET      /file/bot<token>/<file_path> a file by the path getFile gave
 * Every answer is `{ok: true, result}` or `{ok: false, error_code, description}` with the same HTTP status.
 */

type TokenParams = { Params: { token: string; method: string } };

function fail(reply: FastifyReply, e: BotApiError) {
  return reply.status(e.code).send({
    ok: false,
    error_code: e.code,
    description: e.description,
    ...(e.parameters ? { parameters: e.parameters } : {}),
  });
}

/** The bot behind the token, if it may work right now. */
function authorize(token: string): BotRow {
  const bot = getBotByToken(token);
  if (!bot) throw new BotApiError(401, 'Unauthorized');
  if (bot.disabled) throw new BotApiError(403, 'Forbidden: the bot is disabled by the administrator');
  const owner = bot.owner_id ? getUserRow(bot.owner_id) : undefined;
  if (owner?.is_banned) throw new BotApiError(403, 'Forbidden: the bot is blocked');
  const s = getSettings();
  if (s.maintenance) throw new BotApiError(503, 'Service Unavailable: the messenger is down for maintenance');
  return bot;
}

async function collect(req: FastifyRequest): Promise<{ params: Record<string, unknown>; uploads: Map<string, PendingUpload> }> {
  const params: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
  const uploads = new Map<string, PendingUpload>();
  if (req.isMultipart()) {
    const maxMb = getSettings().maxUploadMb;
    try {
      for await (const part of req.parts({ limits: { fileSize: maxMb * 1024 * 1024, files: 10, fields: 200 } })) {
        if (part.type === 'file') uploads.set(part.fieldname, await writeUpload(part.file, part.filename, part.mimetype, maxMb));
        else params[part.fieldname] = part.value;
      }
    } catch (e) {
      for (const u of uploads.values()) fs.rmSync(u.abs, { force: true });
      if (e instanceof HttpError) throw new BotApiError(e.status === 413 ? 413 : 400, `${e.status === 413 ? 'Request Entity Too Large' : 'Bad Request'}: ${e.message}`);
      throw new BotApiError(400, `Bad Request: ${(e as Error).message}`);
    }
  } else if (req.body && typeof req.body === 'object') {
    Object.assign(params, req.body as Record<string, unknown>);
  }
  return { params, uploads };
}

export default async function botApiRoutes(app: FastifyInstance) {
  // Telegram libraries send forms
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.route<TokenParams>({
    method: ['GET', 'POST'],
    url: '/bot:token/:method',
    handler: async (req, reply) => {
      let uploads = new Map<string, PendingUpload>();
      try {
        const bot = authorize(req.params.token);
        const method = req.params.method.toLowerCase();
        // 30 calls a second, like Telegram; waiting for updates is not a call
        if (method !== 'getupdates') {
          try {
            rateLimit(`botapi:${bot.user_id}`, 30, 1000);
          } catch (e) {
            if (e instanceof HttpError) throw fromHttpError(e);
            throw e;
          }
        }
        const got = await collect(req);
        uploads = got.uploads;
        const result = await callBotMethod(bot, method, got.params, uploads, `${req.protocol}://${req.hostname}`);
        return reply.send({ ok: true, result });
      } catch (e) {
        if (e instanceof BotApiError) return fail(reply, e);
        if (e instanceof HttpError) return fail(reply, fromHttpError(e));
        app.log.error(e);
        return fail(reply, new BotApiError(500, 'Internal Server Error'));
      } finally {
        // uploads no method took are not kept
        for (const u of uploads.values()) if (!u.used) fs.rmSync(u.abs, { force: true });
      }
    },
  });

  app.get<{ Params: { token: string; '*': string } }>('/file/bot:token/*', async (req, reply) => {
    try {
      const bot = authorize(req.params.token);
      const rel = req.params['*'];
      const f = db.prepare('SELECT * FROM files WHERE path = ?').get(rel) as FileRow | undefined;
      if (!f || !botCanUse(bot, f)) throw new BotApiError(404, 'Not Found');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      reply.type(f.kind === 'file' ? 'application/octet-stream' : f.mime);
      return reply.sendFile(rel, uploadsDir());
    } catch (e) {
      return fail(reply, e instanceof BotApiError ? e : new BotApiError(500, 'Internal Server Error'));
    }
  });
}
