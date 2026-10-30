import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { seedAdmin } from './auth.js';
import { initBots } from './bots/index.js';
import { importLegacyBank, initPremiumBonus } from './bank/bank.js';
import { config, uploadsDir } from './config.js';
import { initDb } from './db.js';
import { identifyDevice, sendDeviceCookie } from './devices.js';
import { initGameSaves } from './gameSaves.js';
import { warmAllStickers } from './services/stickers.js';
import { initSecretPages, resetSecretKey } from './secret.js';
import { initLeaderboard, startLeaderboardTimer, stopLeaderboardTimer } from './leaderboard.js';
import { initNotifications } from './notifications.js';
import { initPvp, startPvpTimer, stopPvpTimer } from './bank/pvp.js';
import { applyServerLabels } from './labels.js';
import { HttpError } from './errors.js';
import adminRoutes from './routes/admin.js';
import botApiRoutes from './routes/botapi.js';
import botRoutes from './routes/bots.js';
import myBotRoutes from './routes/mybots.js';
import bankRoutes from './routes/bank.js';
import callRoutes from './routes/calls.js';
import contactRoutes from './routes/contacts.js';
import supportRoutes from './routes/support.js';
import notificationRoutes from './routes/notifications.js';
import leaderboardRoutes from './routes/leaderboard.js';
import pvpRoutes from './routes/pvp.js';
import cardRoutes from './routes/cards.js';
import authRoutes from './routes/auth.js';
import badgeRoutes from './routes/badges.js';
import chatRoutes from './routes/chats.js';
import fileRoutes from './routes/files.js';
import folderRoutes from './routes/folders.js';
import linkPreviewRoutes from './routes/linkPreview.js';
import messageRoutes from './routes/messages.js';
import pushRoutes from './routes/push.js';
import pwaRoutes from './routes/pwa.js';
import secretRoutes from './routes/secret.js';
import stickerRoutes from './routes/stickers.js';
import userRoutes from './routes/users.js';
import { resetPushCache } from './push.js';
import { resetSettingsCache } from './settings.js';
import { txt } from './strings.js';

/** the built files of the app and of the docs site: assets/<name>-<hash>.js */
const HASHED_ASSET = /^\/(?:site\/)?assets\/[^?#]+\.[a-z0-9]+(?:[?#]|$)/i;

export async function buildApp(opts: { dbFile?: string; logger?: boolean } = {}) {
  fs.mkdirSync(uploadsDir(), { recursive: true });
  fs.mkdirSync(config.publicDir, { recursive: true });
  initDb(opts.dbFile ?? path.join(config.dataDir, 'timbagram.db'));
  resetSettingsCache();
  resetPushCache();
  applyServerLabels();
  await seedAdmin();
  initNotifications();
  await initBots();
  initPvp();
  initLeaderboard();
  initGameSaves();
  initSecretPages();
  resetSecretKey();
  importLegacyBank();
  initPremiumBonus();
  // the small copies of the sticker pictures are made in the background, the app does not wait for them
  void warmAllStickers().catch(() => {});

  const app = Fastify({
    logger: opts.logger ? { level: 'info' } : false,
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // JSON (message lists, chat lists) shrinks 5–10 times; pictures, video and downloads are never touched (routes/files.ts opts out).
  // Brotli at a low quality: the default (11) would take the processor for every response.
  await app.register(fastifyCompress, {
    threshold: 1024,
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
    zlibOptions: { level: 5 },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart);
  await app.register(fastifyStatic, {
    root: config.publicDir,
    wildcard: false,
    // `npm run build` leaves .br and .gz copies of the text files next to them (scripts/precompress.mjs)
    preCompressed: true,
  });

  // every API request knows its device (a cookie, handed out on the first visit)
  app.decorateRequest('deviceId', '');
  app.decorateRequest('deviceFresh', false);
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/')) identifyDevice(req);
  });

  // the app is never meant to be framed or to leak its addresses to other sites;
  // calls need the camera and the microphone, nothing else is asked for
  app.addHook('onSend', async (req, reply) => {
    sendDeviceCookie(req, reply);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    reply.header('Content-Security-Policy', "base-uri 'self'; object-src 'none'; frame-ancestors 'self'");
    // files under assets/ carry a hash of their content in the name: they never change, so the browser asks for them once
    // (also in the answer "not modified" to a forced reload, or the browser would forget it; not the page that stands in for a file that is gone: it is HTML)
    if ((reply.statusCode === 200 || reply.statusCode === 304) && HASHED_ASSET.test(req.url) && !String(reply.getHeader('content-type')).startsWith('text/html')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    const code = (err as { code?: string }).code;
    const message =
      code === 'FST_REQ_FILE_TOO_LARGE' ? txt.errors.fileTooLarge : status >= 500 ? txt.errors.internal : (err as Error).message;
    return reply.status(status).send({ error: code ?? 'error', message });
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(chatRoutes);
  await app.register(messageRoutes);
  await app.register(fileRoutes);
  await app.register(folderRoutes);
  await app.register(linkPreviewRoutes);
  await app.register(pushRoutes);
  await app.register(pwaRoutes);
  await app.register(badgeRoutes);
  await app.register(adminRoutes);
  await app.register(bankRoutes);
  await app.register(cardRoutes);
  await app.register(callRoutes);
  await app.register(contactRoutes);
  await app.register(supportRoutes);
  await app.register(notificationRoutes);
  await app.register(stickerRoutes);
  await app.register(botRoutes);
  await app.register(myBotRoutes);
  await app.register(botApiRoutes);
  await app.register(pvpRoutes);
  startPvpTimer();
  app.addHook('onClose', async () => stopPvpTimer());
  await app.register(leaderboardRoutes);
  await app.register(secretRoutes);
  startLeaderboardTimer();
  app.addHook('onClose', async () => stopLeaderboardTimer());

  // The docs site (VitePress, docs/) is built into client/dist/site; relative links need the trailing slash
  app.get('/site', (_req, reply) => reply.redirect('/site/'));

  // SPA fallback: any non-API GET serves index.html
  app.setNotFoundHandler((req, reply) => {
    // a file of an older build (a tab left open over a deploy) must not turn into the page: it would fail as a script
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/socket.io') && !HASHED_ASSET.test(req.url)) {
      const index = path.join(config.publicDir, 'index.html');
      if (fs.existsSync(index)) return reply.type('text/html').sendFile('index.html');
      return reply.type('text/plain').send(txt.labels.clientNotBuilt);
    }
    return reply.status(404).send({ error: 'not_found', message: txt.errors.notFound });
  });

  return app;
}
