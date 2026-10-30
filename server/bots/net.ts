import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';
import { assertFetchable, safeLookup } from '../linkPreview.js';

/**
 * The server opens addresses a bot names (webhooks, files "by link"). That makes it a way into the network
 * it sits in, so the same guards as for link previews apply: only http(s), a few ports, never an internal
 * address — checked when the connection is made, so a name that changes its answer leads nowhere.
 * BOT_ALLOW_PRIVATE_URLS=1 lifts the address check (for a bot running on the same machine; tests).
 */

export interface Response {
  status: number;
  contentType: string;
  location: string;
  body: Buffer;
}

export function parseBotUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https');
  if (!config.botAllowPrivate) assertFetchable(url);
  return url;
}

function request(
  url: URL,
  opts: { method: 'GET' | 'POST'; body?: Buffer; headers?: Record<string, string>; maxBytes: number; timeoutMs: number },
): Promise<Response> {
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
        method: opts.method,
        agent: false,
        lookup: config.botAllowPrivate ? undefined : safeLookup,
        headers: { 'User-Agent': 'TimbaGramBot/1.0', ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            req.destroy();
            return finish(() => reject(new Error('response too big')));
          }
          chunks.push(c);
        });
        res.on('end', () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              location: String(res.headers.location ?? ''),
              body: Buffer.concat(chunks),
            }),
          ),
        );
        res.on('error', (e) => finish(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error('timeout')));
    }, opts.timeoutMs);
    req.on('error', (e) => finish(() => reject(e)));
    req.end(opts.body);
  });
}

/** POST of a JSON body (a webhook); the answer is read only as far as the status. */
export function postJson(url: URL, body: unknown, headers: Record<string, string> = {}, timeoutMs = 10_000) {
  return request(url, {
    method: 'POST',
    body: Buffer.from(JSON.stringify(body)),
    headers: { 'Content-Type': 'application/json', ...headers },
    maxBytes: 64 * 1024,
    timeoutMs,
  });
}

/** A file "by link": at most `maxBytes`, up to a few redirects, each one checked like the first address. */
export async function download(raw: string, maxBytes: number, timeoutMs = 20_000): Promise<Response> {
  let url = parseBotUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await request(url, { method: 'GET', maxBytes, timeoutMs });
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = parseBotUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  throw new Error('too many redirects');
}
