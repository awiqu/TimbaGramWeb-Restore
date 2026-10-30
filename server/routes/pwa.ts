import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { config } from '../config.js';
import { notFound } from '../errors.js';
import { getSettings } from '../settings.js';

const SIZES = new Set([72, 192, 512]);
const cache = new Map<string, Buffer>();

/** The logo the admin uploaded (data/branding/logo.png), if any. */
export const customLogoPath = () => path.join(config.dataDir, 'branding', 'logo.png');

/** The built-in logo: the dark one (icons, favicon) or, for the light theme of the app, the pastel one. */
function defaultLogoPath(light = false): string | null {
  const name = light ? 'logo-light.svg' : 'logo.svg';
  const candidates = [path.join(config.publicDir, name), path.resolve(import.meta.dirname, '../../../client/public', name)];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function logoSource(light = false): { file: string; custom: boolean } | null {
  const custom = customLogoPath();
  if (getSettings().logoVersion && fs.existsSync(custom)) return { file: custom, custom: true };
  const def = defaultLogoPath(light);
  return def ? { file: def, custom: false } : null;
}

export function resetIconCache() {
  cache.clear();
}

/** Logo, app icons and the web app manifest — all follow the name and logo set in the admin panel. */
export default async function pwaRoutes(app: FastifyInstance) {
  // ?theme=light: the built-in logo for the light theme of the app (an uploaded logo is the same for both)
  app.get<{ Querystring: { theme?: string } }>('/api/logo', async (req, reply) => {
    const src = logoSource(req.query.theme === 'light');
    if (!src) throw notFound();
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type(src.custom ? 'image/png' : 'image/svg+xml').send(fs.readFileSync(src.file));
  });

  // notifications and home-screen icons need raster images
  app.get<{ Params: { size: string } }>('/api/icon/:size', async (req, reply) => {
    const size = Number.parseInt(req.params.size, 10);
    const src = logoSource();
    if (!SIZES.has(size) || !src) throw notFound();
    const key = `${size}:${getSettings().logoVersion}`;
    let png = cache.get(key);
    if (!png) {
      const input = src.custom ? sharp(src.file) : sharp(src.file, { density: Math.ceil((72 * size) / 64) });
      png = await input.resize(size, size).png().toBuffer();
      cache.set(key, png);
    }
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type('image/png').send(png);
  });

  app.get('/manifest.webmanifest', async (_req, reply) => {
    const s = getSettings();
    const v = s.logoVersion;
    reply.header('Cache-Control', 'no-cache');
    return reply.type('application/manifest+json').send(
      JSON.stringify({
        name: s.appName,
        short_name: s.appName,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#18c29c',
        icons: [
          { src: `/api/icon/192?v=${v}`, sizes: '192x192', type: 'image/png' },
          { src: `/api/icon/512?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      }),
    );
  });
}
