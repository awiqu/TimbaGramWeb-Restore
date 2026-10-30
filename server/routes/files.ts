import type { FastifyInstance } from 'fastify';
import { fileMetaSchema } from '@timba/shared';
import { rateLimit, requireAuth } from '../auth.js';
import { uploadsDir } from '../config.js';
import { notFound } from '../errors.js';
import { fileDTO } from '../serialize.js';
import { addVideoMeta, avatarPath, getFile, previewPath, saveUpload, stickerPath } from '../services/files.js';
import { txt } from '../strings.js';
import { parse } from '../util.js';

/** how long a new video may still be re-encoded in the background */
const SETTLE_MS = 60 * 60_000;

export default async function fileRoutes(app: FastifyInstance) {
  app.post('/api/files', { preHandler: requireAuth }, async (req) => {
    rateLimit(`upload:${req.auth.user.id}`, 40, 60_000);
    return saveUpload(req, req.auth.user);
  });

  // the size, the length and a frame of a video: the browser works them out while the file goes up and sends them after it
  app.post<{ Params: { id: string } }>('/api/files/:id/meta', { preHandler: requireAuth }, async (req) => {
    rateLimit(`filemeta:${req.auth.user.id}`, 120, 60_000);
    return fileDTO(await addVideoMeta(req.auth.user, req.params.id, parse(fileMetaSchema, req.body)));
  });

  app.get<{ Params: { id: string }; Querystring: { thumb?: string; download?: string; preview?: string; avatar?: string; sticker?: string } }>(
    '/api/files/:id',
    // pictures and video are compressed already, and a Range answer must stay as it is
    { preHandler: requireAuth, compress: false },
    async (req, reply) => {
      const f = getFile(req.params.id);
      if (!f) throw notFound(txt.errors.fileNotFound);
      // a few KB for an avatar circle; where there is none (a GIF) the thumbnail does
      const sticker = req.query.sticker === '1' ? await stickerPath(f) : req.query.sticker === 's' ? await stickerPath(f, true) : null;
      const small = !sticker && req.query.avatar === '1' ? await avatarPath(f) : null;
      const useThumb = !sticker && !small && (req.query.thumb === '1' || req.query.avatar === '1') && f.thumb_path;
      // the viewer asks for a copy that fits a screen; the original stays for "download"
      const preview = !sticker && !small && !useThumb && req.query.preview === '1' ? await previewPath(f) : null;
      const rel = sticker ?? small ?? (useThumb ? f.thumb_path! : (preview ?? f.path));
      const attachment = f.kind === 'file' || req.query.download === '1';
      reply.header('X-Content-Type-Options', 'nosniff');
      // a file never changes, except a fresh video that is swapped for its lighter copy (services/video.ts): until then it is checked every time
      const settling = f.kind === 'video' && rel === f.path && Date.now() - f.created_at < SETTLE_MS;
      reply.header('Cache-Control', settling ? 'private, no-cache' : 'private, max-age=31536000, immutable');
      reply.header(
        'Content-Disposition',
        `${attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      );
      if (sticker || small || useThumb || preview) reply.type('image/webp');
      else if (f.kind !== 'file') reply.type(f.mime);
      else reply.type('application/octet-stream');
      // cacheControl off: otherwise sendFile puts its own "max-age=0" over the header above and every view asks the server again
      return reply.sendFile(rel, uploadsDir(), { cacheControl: false });
    },
  );
}
