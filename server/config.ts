import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env — use defaults / real env
}
// keys moved over from the PupsoBank bot (GC_API); anything set in .env or the environment wins
try {
  process.loadEnvFile(path.join(root, 'server', 'pupsobank.env'));
} catch {
  // not there
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(root, process.env.DATA_DIR ?? 'data'),
  publicDir: path.resolve(root, process.env.PUBLIC_DIR ?? 'client/dist'),
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin12345',
  /** the PIN of /secret/blooms (a tower defence game) */
  bloomsPassword: process.env.BLOOMS_PASSWORD?.trim() || '5638',
  sessionDays: 180,
  /** contact for push services (VAPID "subject"): mailto: or https: URL */
  pushContact: process.env.PUSH_CONTACT ?? 'mailto:timbagram@example.com',
  /** https address of the site; pages opened over plain http offer to switch to it */
  publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
  /** GigaChat authorization key (GC_API, as in the PupsoBank bot): support chat */
  gigachatKey: (process.env.GC_API ?? process.env.GIGACHAT_KEY ?? '').trim(),
  /** polza.ai, an OpenAI compatible API (voice transcription) */
  polzaKey: (process.env.POLZA_API_KEY ?? process.env.POLZA_KEY ?? '').trim(),
  polzaBaseUrl: (process.env.POLZA_BASE_URL?.trim() || 'https://polza.ai/api/v1').replace(/\/+$/, ''),
  polzaModel: process.env.POLZA_MODEL?.trim() || 'deepseek/deepseek-v4-flash',
  /**
   * Voice transcription: any OpenAI compatible /audio/transcriptions endpoint.
   * By default the polza.ai key and address, model openai/whisper-large-v3-turbo.
   */
  transcribeKey: (process.env.TRANSCRIBE_API_KEY ?? '').trim() || (process.env.POLZA_API_KEY ?? process.env.POLZA_KEY ?? '').trim() || (process.env.GROQ_API_KEY ?? '').trim(),
  // the polza.ai key and address serve the transcription; Groq only when it is the sole key
  transcribeBaseUrl: (
    process.env.TRANSCRIBE_BASE_URL?.trim() ||
    (!(process.env.TRANSCRIBE_API_KEY || process.env.POLZA_API_KEY || process.env.POLZA_KEY) && process.env.GROQ_API_KEY
      ? 'https://api.groq.com/openai/v1'
      : process.env.POLZA_BASE_URL?.trim() || 'https://polza.ai/api/v1')
  ).replace(/\/+$/, ''),
  transcribeModel:
    process.env.TRANSCRIBE_MODEL?.trim() ||
    (!(process.env.TRANSCRIBE_API_KEY || process.env.POLZA_API_KEY || process.env.POLZA_KEY) && process.env.GROQ_API_KEY
      ? 'whisper-large-v3-turbo'
      : 'openai/whisper-large-v3-turbo'),
  /**
   * Calls: public STUN servers are enough when at least one side is not behind a strict NAT.
   * A TURN server (coturn, `docker compose --profile turn`) relays the rest. TURN_SECRET is
   * coturn's static-auth-secret (short-lived passwords); or a fixed TURN_USERNAME/TURN_PASSWORD.
   */
  stunUrls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // coturn from docker-compose (`--profile turn`) on the same domain: TURN_SECRET alone is enough
  turnUrls: (
    process.env.TURN_URLS?.trim() ||
    (process.env.TURN_SECRET?.trim() && process.env.DOMAIN?.trim()
      ? `turn:${process.env.DOMAIN.trim()}:3478?transport=udp,turn:${process.env.DOMAIN.trim()}:3478?transport=tcp`
      : '')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  turnSecret: (process.env.TURN_SECRET ?? '').trim(),
  turnUsername: (process.env.TURN_USERNAME ?? '').trim(),
  turnPassword: (process.env.TURN_PASSWORD ?? '').trim(),
  /** bots: webhooks and files "by link" may point to internal addresses (a bot on the same machine); off by default */
  botAllowPrivate: process.env.BOT_ALLOW_PRIVATE_URLS === '1',
  gigachatScope: process.env.GIGACHAT_SCOPE?.trim() || 'GIGACHAT_API_PERS',
  /** optional PEM with the Russian Trusted Root CA; set = GigaChat certificates are verified */
  gigachatCaFile: process.env.GIGACHAT_CA_FILE?.trim() || '',
};

export const uploadsDir = () => path.join(config.dataDir, 'uploads');
