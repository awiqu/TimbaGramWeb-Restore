import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { LinkPreviewDTO } from '@timba/shared';
import sharp from 'sharp';

/**
 * Link previews — the card under a message with a link (title, text, picture), as in Telegram.
 *
 * The server opens the address, and that makes it a way into the network it sits in, so everything here is
 * defensive: only http(s) on a few ports, never an internal address (checked when the connection is made,
 * not just when the name is looked at — a name may change its answer), a hand-followed chain of redirects,
 * small answers, short waits. The picture is fetched by the server too, so the reader's address is not
 * shown to the site and the card works on https pages.
 */

const PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_REDIRECTS = 4;
const HTML_MAX = 512 * 1024;
const IMAGE_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const PREVIEW_TTL = 6 * 3600_000;
const MISS_TTL = 10 * 60_000;
const CACHE_MAX = 500;
const IMAGES_MAX = 150;
const PARALLEL_MAX = 8;
const UA = 'Mozilla/5.0 (compatible; TimbaGramBot/1.0; link preview)';

// ---------- which addresses are off limits ----------
const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
  ['::', 128],
  ['::1', 128],
  // no ::ffff:0:0/96 here: the list already reads ::ffff:a.b.c.d by the IPv4 rules, and that subnet would match every IPv4 address
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

/** Internal, reserved or not an address at all. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (!family || address.includes('%')) return true;
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** What can be checked before any connection: scheme, login in the address, port, an address written as numbers. */
export function assertFetchable(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
  if (url.username || url.password) throw new Error('credentials');
  if (!PORTS.has(url.port)) throw new Error('port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // an address written as numbers is not looked up, so it must be judged here
  if (net.isIP(host) && isBlockedAddress(host)) throw new Error('internal address');
  if (!host || host.endsWith('.')) throw new Error('host');
}

/** DNS for the connection: only public answers get through, so a name pointing inside leads nowhere. */
export const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const ok = addresses.filter((a) => !isBlockedAddress(a.address));
    if (!ok.length) return callback(new Error('internal address'), '', 0);
    if (options.all) return callback(null, ok);
    callback(null, ok[0]!.address, ok[0]!.family);
  });
};

// ---------- fetching ----------
export interface FetchOptions {
  /** tests only: the routes never set these */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

interface Page {
  url: URL;
  contentType: string;
  body: Buffer;
}

/** One request, no redirects. The body is cut at `max` bytes (`strict`: refused instead). */
function get(url: URL, accept: string, max: number, strict: boolean, opts: FetchOptions): Promise<{ res: http.IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: opts.allowPrivate ? undefined : safeLookup,
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'ru,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const len = Number(res.headers['content-length']);
        if (strict && len > max) {
          req.destroy();
          return finish(() => reject(new Error('too big')));
        }
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > max) {
            if (strict) {
              req.destroy();
              return finish(() => reject(new Error('too big')));
            }
            chunks.push(c.subarray(0, c.length - (size - max)));
            req.destroy();
            return finish(() => resolve({ res, body: Buffer.concat(chunks) }));
          }
          chunks.push(c);
        });
        res.on('end', () => finish(() => resolve({ res, body: Buffer.concat(chunks) })));
        res.on('error', (e) => finish(() => reject(e)));
        // the connection dropped half way: a cut picture is no picture
        res.on('close', () => finish(() => (res.complete ? resolve({ res, body: Buffer.concat(chunks) }) : reject(new Error('aborted')))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error('timeout')));
    }, opts.timeoutMs ?? TIMEOUT_MS);
    req.on('error', (e) => finish(() => reject(e)));
    req.end();
  });
}

/**
 * Unpack what the site sent. The output is cut at `max` instead of refused: a real page may be far bigger
 * than the limit once unpacked (its tags are at the start), and a small download may hide a huge file.
 * A broken or cut archive gives whatever could be read from it.
 */
function decode(body: Buffer, encoding: string | undefined, max: number): Promise<Buffer> {
  const enc = (encoding ?? '').toLowerCase().trim();
  const stream =
    enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
  if (!stream) return Promise.resolve(body);
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      stream.destroy();
      resolve(Buffer.concat(out));
    };
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size < max) return void out.push(c);
      out.push(c.subarray(0, c.length - (size - max)));
      done();
    });
    stream.on('end', done);
    stream.on('error', done);
    stream.end(body);
  });
}

/** The page behind an address, following up to a few redirects by hand — every hop is checked again. */
async function fetchPage(start: URL, accept: string, max: number, strict: boolean, opts: FetchOptions): Promise<Page> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!opts.allowPrivate) assertFetchable(url);
    const { res, body } = await get(url, accept, max, strict, opts);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`status ${status}`);
    return { url, contentType: String(res.headers['content-type'] ?? ''), body: await decode(body, res.headers['content-encoding'], max) };
  }
  throw new Error('too many redirects');
}

// ---------- reading a page ----------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const tidy = (s: string | undefined, max: number) => {
  const text = decodeEntities(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/** The page text; the charset comes from the header or from the first bytes of the page (Russian sites still use windows-1251). */
function pageText(body: Buffer, contentType: string): string {
  const head = body.subarray(0, 2048).toString('latin1');
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export interface PageInfo {
  siteName: string;
  title: string;
  description: string;
  image: string | null;
}

/** Title, description, picture and site name of an HTML page (Open Graph first, then Twitter cards, then plain tags). */
export function parsePage(html: string, base: URL): PageInfo | null {
  const end = html.search(/<\/head>/i);
  const head = end === -1 ? html : html.slice(0, end);
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
  }
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];

  const title = tidy(pick('og:title', 'twitter:title') ?? titleTag, 160);
  const description = tidy(pick('og:description', 'twitter:description', 'description'), 320);
  if (!title && !description) return null;

  let image: string | null = null;
  const src = pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src');
  if (src) {
    try {
      const u = new URL(decodeEntities(src.trim()), base);
      if (u.protocol === 'http:' || u.protocol === 'https:') image = u.href;
    } catch {
      /* no picture */
    }
  }
  return { siteName: tidy(pick('og:site_name', 'application-name'), 60) || base.hostname.replace(/^www\./, ''), title, description, image };
}

// ---------- the picture ----------
const images = new Map<string, Buffer>();

/** A card picture saved by its id (a small copy: the original may be huge). */
export function getPreviewImage(id: string): Buffer | undefined {
  const img = images.get(id);
  if (img) {
    // most recently used goes last
    images.delete(id);
    images.set(id, img);
  }
  return img;
}

async function savePicture(src: string, opts: FetchOptions): Promise<LinkPreviewDTO['image']> {
  try {
    const page = await fetchPage(new URL(src), 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5', IMAGE_MAX, true, opts);
    // svg can pull other files in when rendered: only plain pictures
    if (/svg|html|xml/i.test(page.contentType)) return null;
    const out = await sharp(page.body, { limitInputPixels: 40_000_000, animated: false })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (out.info.width < 40 || out.info.height < 40) return null;
    const id = createHash('sha1').update(src).digest('hex').slice(0, 20);
    images.delete(id);
    images.set(id, out.data);
    while (images.size > IMAGES_MAX) images.delete(images.keys().next().value!);
    return { id, width: out.info.width, height: out.info.height };
  } catch {
    return null;
  }
}

// ---------- the card ----------
const cache = new Map<string, { at: number; value: LinkPreviewDTO | null }>();
const inflight = new Map<string, Promise<LinkPreviewDTO | null>>();
let active = 0;

export class PreviewBusy extends Error {}

async function build(address: string, opts: FetchOptions): Promise<LinkPreviewDTO | null> {
  try {
    const start = new URL(address);
    const page = await fetchPage(start, 'text/html,application/xhtml+xml;q=0.9', HTML_MAX, false, opts);
    if (!/html/i.test(page.contentType)) return null;
    const info = parsePage(pageText(page.body, page.contentType), page.url);
    if (!info) return null;
    const image = info.image ? await savePicture(info.image, opts) : null;
    return { url: start.href, siteName: info.siteName, title: info.title, description: info.description, image };
  } catch {
    return null;
  }
}

/** The card for an address, from memory when it was made lately. null: nothing worth showing. */
export async function getLinkPreview(address: string, opts: FetchOptions = {}): Promise<LinkPreviewDTO | null> {
  let key: string;
  try {
    const u = new URL(address);
    u.hash = '';
    key = u.href;
  } catch {
    return null;
  }
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? PREVIEW_TTL : MISS_TTL)) return hit.value;
  const running = inflight.get(key);
  if (running) return running;
  // the server is not a crawler: a crowd of different addresses at once has to wait
  if (active >= PARALLEL_MAX) throw new PreviewBusy();

  active++;
  const job = build(key, opts)
    .then((value) => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), value });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return value;
    })
    .finally(() => {
      active--;
      inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
}

/** For tests: forget everything. */
export function resetLinkPreviews() {
  cache.clear();
  images.clear();
}
