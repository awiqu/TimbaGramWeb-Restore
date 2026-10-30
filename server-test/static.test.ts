import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-static-'));
const pub = path.join(tmp, 'public');
const js = 'export const answer = () => 42;\n'.repeat(200);

beforeAll(async () => {
  fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(pub, 'site', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(pub, 'assets', 'App-abc123.js'), js);
  fs.writeFileSync(path.join(pub, 'assets', 'App-abc123.js.br'), zlib.brotliCompressSync(js));
  fs.writeFileSync(path.join(pub, 'assets', 'App-abc123.js.gz'), zlib.gzipSync(js));
  fs.writeFileSync(path.join(pub, 'site', 'assets', 'docs-def456.css'), 'a{color:red}');
  config.dataDir = path.join(tmp, 'data');
  config.publicDir = pub;
  app = await buildApp({ dbFile: ':memory:' });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the built app', () => {
  it('sends the ready-made brotli or gzip copy of a file and keeps a hashed file in the cache for good', async () => {
    const br = await app.inject({ method: 'GET', url: '/assets/App-abc123.js', headers: { 'accept-encoding': 'br, gzip' } });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toContain('javascript');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(zlib.brotliDecompressSync(br.rawPayload).toString()).toBe(js);

    const gz = await app.inject({ method: 'GET', url: '/assets/App-abc123.js', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gz.rawPayload).toString()).toBe(js);

    const plain = await app.inject({ method: 'GET', url: '/assets/App-abc123.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(js);

    // a forced reload asks "has it changed?": the answer must keep the file in the cache for good
    const etag = String(br.headers.etag);
    const same = await app.inject({ method: 'GET', url: '/assets/App-abc123.js', headers: { 'accept-encoding': 'br', 'if-none-match': etag } });
    expect(same.statusCode).toBe(304);
    expect(same.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const docs = await app.inject({ method: 'GET', url: '/site/assets/docs-def456.css' });
    expect(docs.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('checks the page itself every time, and answers a file of an older build with 404 instead of the page', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).not.toContain('immutable');
    // a route of the app: the page, never cached for good
    const route = await app.inject({ method: 'GET', url: '/chat/12' });
    expect(route.body).toContain('<title>app</title>');
    expect(route.headers['cache-control'] ?? '').not.toContain('immutable');
    // a script that is gone must not come back as HTML (and must not stay in the cache)
    const gone = await app.inject({ method: 'GET', url: '/assets/App-old999.js' });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['cache-control'] ?? '').not.toContain('immutable');
    expect((await app.inject({ method: 'GET', url: '/site/assets/gone-000.js' })).statusCode).toBe(404);
  });
});
