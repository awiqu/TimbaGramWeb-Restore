import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFetchable,
  getLinkPreview,
  getPreviewImage,
  isBlockedAddress,
  parsePage,
  resetLinkPreviews,
  safeLookup,
} from '../src/linkPreview.js';

describe('link previews: where the server may not go', () => {
  it('refuses internal and reserved addresses, allows public ones', () => {
    for (const a of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fd00::1',
      'fc00::5',
      '::ffff:127.0.0.1', // IPv4 in IPv6 clothes
      '::ffff:10.0.0.1',
      '64:ff9b::7f00:1',
      'not-an-address',
      'fe80::1%eth0',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e']) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });

  it('refuses addresses before connecting, however they are written', () => {
    for (const u of [
      'ftp://example.com/',
      'file:///etc/passwd',
      'gopher://example.com/',
      'http://user:pass@example.com/',
      'http://example.com:22/',
      'http://example.com:6379/',
      'http://127.0.0.1/',
      'http://127.0.0.1:8080/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/', // 127.0.0.1 as one number
      'http://0x7f.1/', // ...in hex
      'http://0177.0.0.1/', // ...in octal
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1:8080/',
      'http://192.168.0.1/',
      'http://0.0.0.0/',
    ]) {
      expect(() => assertFetchable(new URL(u)), u).toThrow();
    }
    for (const u of ['https://example.com/', 'http://example.com/a?b=1#c', 'https://example.com:8443/', 'http://example.com:8080/', 'https://xn--e1afmkfd.xn--p1ai/']) {
      expect(() => assertFetchable(new URL(u)), u).not.toThrow();
    }
  });

  it('a name that points inside leads nowhere (checked when the connection is made)', async () => {
    for (const host of ['localhost', 'localhost.localdomain']) {
      const r = await new Promise<{ err: Error | null; list: unknown }>((resolve) =>
        safeLookup(host, { all: true }, (err, list) => resolve({ err, list })),
      );
      // either the name does not exist here or it points inside: in no case an address to connect to
      expect(r.err, host).not.toBeNull();
    }
  });
});

describe('link previews: reading a page', () => {
  const base = new URL('https://news.example.com/2026/story.html');

  it('takes Open Graph tags, decodes entities, resolves the picture', () => {
    const info = parsePage(
      `<html><head><title>Plain title</title>
       <meta property="og:title" content="Tom &amp; Jerry &#8212; &laquo;Pilot&raquo;">
       <meta property='og:description' content="Line one
          line two">
       <meta property="og:image" content="/img/cover.jpg">
       <meta property="og:site_name" content="Example News">
       </head><body><h1>x</h1></body></html>`,
      base,
    );
    expect(info).toEqual({
      siteName: 'Example News',
      title: 'Tom & Jerry — «Pilot»',
      description: 'Line one line two',
      image: 'https://news.example.com/img/cover.jpg',
    });
  });

  it('falls back to the title tag, the description tag and the host name', () => {
    const info = parsePage('<head><title> Just   a title </title><meta name="description" content="About it"></head>', base);
    expect(info).toMatchObject({ siteName: 'news.example.com', title: 'Just a title', description: 'About it', image: null });
  });

  it('knows nothing worth a card for an empty page, and ignores tags past the head', () => {
    expect(parsePage('<html><head></head><body><meta property="og:title" content="Sneaky"></body></html>', base)).toBeNull();
    expect(parsePage('<p>hello</p>', base)).toBeNull();
  });

  it('does not take odd picture addresses', () => {
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://x.y/a.png']) {
      const info = parsePage(`<head><meta property="og:title" content="t"><meta property="og:image" content="${src}"></head>`, base);
      expect(info?.image, src).toBeNull();
    }
  });

  it('cuts long texts', () => {
    const info = parsePage(`<head><meta property="og:title" content="${'a'.repeat(500)}"></head>`, base)!;
    expect(info.title.length).toBeLessThanOrEqual(160);
    expect(info.title.endsWith('…')).toBe(true);
  });
});

describe('link previews: fetching (local test server)', () => {
  let server: http.Server;
  let origin: string;
  let png: Buffer;
  let hits: Record<string, number> = {};

  beforeAll(async () => {
    png = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#cc3333' } }).png().toBuffer();
    server = http.createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      hits[path] = (hits[path] ?? 0) + 1;
      const html = (body: string, type = 'text/html; charset=utf-8') => {
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
      };
      switch (path) {
        case '/page':
          return html(
            `<head><meta property="og:title" content="Hello"><meta property="og:description" content="World">
             <meta property="og:image" content="/cover.png"></head>`,
          );
        case '/cover.png':
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return void res.end(png);
        case '/redirect':
          res.writeHead(302, { Location: '/page' });
          return void res.end();
        case '/loop':
          res.writeHead(302, { Location: '/loop' });
          return void res.end();
        case '/gzip':
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
          return void res.end(zlib.gzipSync('<head><title>Zipped</title></head>'));
        case '/bomb':
          // a few KB that unpack to far more than the limit
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
          return void res.end(zlib.gzipSync(`<head><title>Bomb</title></head>${'x'.repeat(5 * 1024 * 1024)}`));
        case '/bigpage':
          // a real page: megabytes once unpacked, the tags at the start
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
          return void res.end(zlib.gzipSync(`<head><meta property="og:title" content="Big page"></head><body>${'<p>text</p>'.repeat(300_000)}</body>`));
        case '/cp1251':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return void res.end(Buffer.concat([Buffer.from('<head><meta charset="windows-1251"><title>'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from('</title></head>')]));
        case '/text':
          return html('<title>Not html</title>', 'text/plain');
        case '/json':
          return html('{"title":"x"}', 'application/json');
        case '/missing':
          res.writeHead(404);
          return void res.end('nope');
        case '/svg-cover':
          return html('<head><meta property="og:title" content="Svg"><meta property="og:image" content="/pic.svg"></head>');
        case '/pic.svg':
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
          return void res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200"/></svg>');
        case '/huge-cover':
          return html('<head><meta property="og:title" content="Huge"><meta property="og:image" content="/huge.bin"></head>');
        case '/huge.bin':
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(50 * 1024 * 1024) });
          return void res.end(Buffer.alloc(1024));
        case '/slow':
          return; // never answers
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    resetLinkPreviews();
    hits = {};
  });

  const preview = (path: string) => getLinkPreview(`${origin}${path}`, { allowPrivate: true });

  it('builds a card with a shrunk copy of the picture', async () => {
    const p = await preview('/page');
    expect(p).toMatchObject({ title: 'Hello', description: 'World', siteName: '127.0.0.1' });
    expect(p!.image).not.toBeNull();
    expect(p!.image!.width).toBeLessThanOrEqual(640);
    expect(p!.image!.width / p!.image!.height).toBeCloseTo(2, 1);
    const copy = getPreviewImage(p!.image!.id)!;
    expect((await sharp(copy).metadata()).format).toBe('webp');
    expect(copy.length).toBeLessThan(png.length);
  });

  it('keeps cards in memory instead of asking the site again', async () => {
    await preview('/page');
    await preview('/page');
    await Promise.all([preview('/page#frag'), preview('/page')]);
    expect(hits['/page']).toBe(1);
  });

  it('follows redirects, but not forever', async () => {
    expect((await preview('/redirect'))?.title).toBe('Hello');
    expect(await preview('/loop')).toBeNull();
  });

  it('reads compressed pages and other encodings', async () => {
    expect((await preview('/gzip'))?.title).toBe('Zipped');
    expect((await preview('/cp1251'))?.title).toBe('Привет');
  });

  it('shows nothing for what is not a page', async () => {
    for (const path of ['/text', '/json', '/missing', '/nothing-here']) expect(await preview(path), path).toBeNull();
  });

  it('reads the start of a page that is huge once unpacked (and is not hurt by a zip bomb)', async () => {
    expect((await preview('/bigpage'))?.title).toBe('Big page');
    expect((await preview('/bomb'))?.title).toBe('Bomb');
  });

  it('drops pictures that are unsafe or too big, but keeps the card', async () => {
    expect((await preview('/svg-cover'))).toMatchObject({ title: 'Svg', image: null });
    expect((await preview('/huge-cover'))).toMatchObject({ title: 'Huge', image: null });
  });

  it('does not wait for a site that never answers', async () => {
    const started = Date.now();
    expect(await getLinkPreview(`${origin}/slow`, { allowPrivate: true, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('without the test switch the same local site is refused', async () => {
    expect(await getLinkPreview(`${origin}/page`)).toBeNull();
    expect(hits['/page']).toBeUndefined();
  });
});
