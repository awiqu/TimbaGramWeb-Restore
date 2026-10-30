import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors.js';
import { badgeImage } from '../profile.js';
import { intParam } from '../util.js';
import { txt } from '../strings.js';

/** The picture of a badge. Open like the logo: it is a public part of every profile, and the address carries the version. */
export default async function badgeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/badges/:id/image', async (req, reply) => {
    const image = badgeImage(intParam(req.params.id));
    if (!image) throw notFound(txt.profile.badgeNotFound);
    // ?v= changes with the picture, so the browser may keep it for good
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type('image/png').send(image);
  });
}
