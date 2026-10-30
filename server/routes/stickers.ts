import { addStickerSchema, editStickerSchema, stickerPackTitleSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import {
  addPackToPanel,
  addSticker,
  createPack,
  deletePack,
  deleteSticker,
  editSticker,
  getPackById,
  getPackByToken,
  listMyPacks,
  renamePack,
  resetPackLink,
} from '../services/stickers.js';
import { intParam, parse } from '../util.js';

type IdParams = { Params: { id: string } };

/** Стикерпаки: the panel, the Премиум editor and adding a pack by its link. */
export default async function stickerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/stickers', async (req) => listMyPacks(req.auth.user));

  app.post('/api/stickers/packs', async (req) => createPack(req.auth.user, parse(stickerPackTitleSchema, req.body).title));

  app.get<IdParams>('/api/stickers/packs/:id', async (req) => getPackById(intParam(req.params.id), req.auth.user));

  app.patch<IdParams>('/api/stickers/packs/:id', async (req) =>
    renamePack(intParam(req.params.id), req.auth.user, parse(stickerPackTitleSchema, req.body).title),
  );

  app.delete<IdParams>('/api/stickers/packs/:id', async (req) => {
    deletePack(intParam(req.params.id), req.auth.user);
    return { ok: true };
  });

  app.post<IdParams>('/api/stickers/packs/:id/add', async (req) => addPackToPanel(intParam(req.params.id), req.auth.user));

  app.post<IdParams>('/api/stickers/packs/:id/link', async (req) => resetPackLink(intParam(req.params.id), req.auth.user));

  app.post<IdParams>('/api/stickers/packs/:id/stickers', async (req) =>
    addSticker(intParam(req.params.id), req.auth.user, parse(addStickerSchema, req.body)),
  );

  app.patch<IdParams>('/api/stickers/:id', async (req) => editSticker(intParam(req.params.id), req.auth.user, parse(editStickerSchema, req.body)));

  app.delete<IdParams>('/api/stickers/:id', async (req) => deleteSticker(intParam(req.params.id), req.auth.user));

  app.get<{ Params: { token: string } }>('/api/stickers/share/:token', async (req) =>
    getPackByToken(String(req.params.token).slice(0, 64), req.auth.user),
  );
}
