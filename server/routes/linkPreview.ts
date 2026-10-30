import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rateLimit, requireAuth } from '../auth.js';
import { HttpError, notFound } from '../errors.js';
import { PreviewBusy, getLinkPreview, getPreviewImage } from '../linkPreview.js';
import { parse } from '../util.js';

/** Cards for links in messages: the page's title, text and picture. */
export default async function linkPreviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/link-preview', async (req) => {
    const { url } = parse(z.object({ url: z.string().max(2000).url() }), req.query);
    rateLimit(`link-preview:${req.auth.user.id}`, 90, 60_000);
    try {
      return { preview: await getLinkPreview(url) };
    } catch (e) {
      if (e instanceof PreviewBusy) throw new HttpError(429, 'busy', 'Too many link previews at once');
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/api/link-preview/image/:id', async (req, reply) => {
    const img = /^[0-9a-f]{20}$/.test(req.params.id) ? getPreviewImage(req.params.id) : undefined;
    if (!img) throw notFound();
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', 'private, max-age=86400').send(img);
  });
}
