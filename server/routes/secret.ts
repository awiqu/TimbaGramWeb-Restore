import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rateLimit } from '../auth.js';
import { HttpError, badRequest } from '../errors.js';
import { BLOOMS_SAVE_MAX_BYTES, adopt, checkPassword, loadSave, storeSave, unlock, unlockedId } from '../secret.js';
import { txt } from '../strings.js';
import { parse } from '../util.js';

const unlockSchema = z.object({ password: z.string().max(64) });
const linkSchema = z.object({ code: z.string().trim().max(64) });
const saveSchema = z.object({ save: z.record(z.unknown()) });

/** /secret/blooms: no account needed, only the PIN; the progress of an unlocked browser is kept here. */
export default async function secretRoutes(app: FastifyInstance) {
  // is this browser unlocked? if it is, its saved progress comes along
  app.get('/api/secret/blooms', async (req) => {
    const id = unlockedId(req);
    return id ? { ok: true, save: loadSave(id) } : { ok: false };
  });

  app.post('/api/secret/blooms/unlock', async (req, reply) => {
    // four digits are quickly guessed without a limit
    rateLimit(`secret-pin:${req.ip}`, 8, 10 * 60_000);
    const { password } = parse(unlockSchema, req.body);
    if (!checkPassword(password.trim())) throw new HttpError(403, 'wrong_password', txt.secret.wrongPassword);
    const id = unlock(req, reply);
    return { ok: true, save: loadSave(id) };
  });

  // the code of this browser's progress, to carry it to another browser (on an iPad the home screen app is one)
  app.get('/api/secret/blooms/code', async (req) => {
    const id = unlockedId(req);
    if (!id) throw new HttpError(403, 'locked', txt.secret.locked);
    return { code: id };
  });

  // take over the progress of another browser by its code; the caller merges it with its own
  app.post('/api/secret/blooms/link', async (req, reply) => {
    if (!unlockedId(req)) throw new HttpError(403, 'locked', txt.secret.locked);
    rateLimit(`secret-link:${req.ip}`, 10, 10 * 60_000);
    const { code } = parse(linkSchema, req.body);
    const save = /^[A-Za-z0-9_-]{16,64}$/.test(code) ? loadSave(code) : null;
    if (!save) throw new HttpError(404, 'no_save', txt.secret.noSave);
    adopt(reply, req, code);
    return { ok: true, save };
  });

  app.put('/api/secret/blooms/save', async (req) => {
    const id = unlockedId(req);
    if (!id) throw new HttpError(403, 'locked', txt.secret.locked);
    rateLimit(`secret-save:${id}`, 120, 60_000);
    const { save } = parse(saveSchema, req.body);
    if (JSON.stringify(save).length > BLOOMS_SAVE_MAX_BYTES) throw badRequest(txt.secret.tooBig);
    storeSave(id, save);
    return { ok: true };
  });
}
