import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { config } from './config.js';

/**
 * GigaChat (Sber) — the same API the PupsoBank VK bot uses (gigachat_command.py).
 * Sber signs its endpoints with the "Russian Trusted Root CA" of the Ministry of Digital
 * Development, which is missing from the standard trust store. By the owner's choice this works
 * like the bot (verify=False): without GIGACHAT_CA_FILE the certificate of these two Sber hosts is
 * not checked. With GIGACHAT_CA_FILE set, that root is trusted and certificates are verified.
 */
const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

let agent: https.Agent | null = null;
function getAgent(): https.Agent {
  if (agent) return agent;
  const extra = config.gigachatCaFile ? fs.readFileSync(config.gigachatCaFile, 'utf8') : null;
  agent = extra
    ? new https.Agent({ keepAlive: true, ca: [...tls.rootCertificates, extra] })
    : new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  return agent;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const gigachatAvailable = () => !!config.gigachatKey;

function request(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', agent: getAgent(), headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  // like the bot: the key is "client_id:secret"; an already encoded key is passed as is
  const key = config.gigachatKey;
  const basic = key.includes(':') ? Buffer.from(key).toString('base64') : key;
  const res = await request(
    OAUTH_URL,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      RqUID: crypto.randomUUID(),
      Authorization: `Basic ${basic}`,
    },
    `scope=${encodeURIComponent(config.gigachatScope)}`,
    10_000,
  );
  if (res.status !== 200 || !res.json?.access_token) throw new Error(`GigaChat auth ${res.status}`);
  token = { value: res.json.access_token, expiresAt: Number(res.json.expires_at) || Date.now() + 25 * 60_000 };
  return token.value;
}

/** One completion; throws when GigaChat is not configured or does not answer. */
export async function askGigaChat(messages: ChatMessage[], maxTokens = 512): Promise<string> {
  if (!gigachatAvailable()) throw new Error('GigaChat is not configured');
  const send = async () =>
    request(
      CHAT_URL,
      { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      JSON.stringify({ model: 'GigaChat', messages, temperature: 0.7, max_tokens: maxTokens }),
      30_000,
    );
  let res = await send();
  if (res.status === 401) {
    token = null;
    res = await send();
  }
  const answer = res.json?.choices?.[0]?.message?.content;
  if (res.status !== 200 || typeof answer !== 'string' || !answer.trim()) throw new Error(`GigaChat ${res.status}`);
  return answer.trim();
}
