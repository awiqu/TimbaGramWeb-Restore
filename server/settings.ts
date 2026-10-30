import { APP_NAME, APP_VERSION, PREMIUM_PRICE, type AppStatus } from '@timba/shared';
import { config } from './config.js';
import { db } from './db.js';
import { txt } from './strings.js';

interface Settings {
  maintenance: boolean;
  maintenanceMessage: string;
  registrationOpen: boolean;
  maxUploadMb: number;
  appName: string;
  version: string;
  buildId: number;
  /** 0 = the built-in logo; otherwise the time the admin uploaded their own */
  logoVersion: number;
  announcement: string;
  groupCreation: boolean;
  channelCreation: boolean;
  uploadsEnabled: boolean;
  /** «Поддержать проект» in About: a donation page (ЮMoney, CloudTips…); empty = no button */
  donateUrl: string;
  /** "Оплатить" in the top-up dialog opens this page; empty = pay by the phone number */
  topupUrl: string;
  /** "Оплатить" on the TimbaGram Premium screen opens this page; empty = pay by the phone number */
  premiumUrl: string;
  /** ₽ a month */
  premiumPrice: number;
  /** support answers tickets automatically; off = every ticket goes straight to the operator */
  supportBot: boolean;
  /** replaced interface texts, see shared/src/labels.ts; sent separately from the status */
  labels: Record<string, string>;
  /** bumped on every change of the labels */
  labelsVersion: number;
}

const defaults: Settings = {
  maintenance: false,
  maintenanceMessage: txt.labels.defaultMaintenance,
  registrationOpen: true,
  maxUploadMb: 100,
  appName: APP_NAME,
  version: APP_VERSION,
  buildId: 0,
  logoVersion: 0,
  announcement: '',
  groupCreation: true,
  channelCreation: true,
  uploadsEnabled: true,
  donateUrl: '',
  topupUrl: '',
  premiumUrl: '',
  premiumPrice: PREMIUM_PRICE,
  supportBot: true,
  labels: {},
  labelsVersion: 0,
};

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  const s: Settings = { ...defaults };
  for (const r of rows) {
    if (r.key in s) (s as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
  }
  cache = s;
  return s;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k in defaults) stmt.run(k, JSON.stringify(v));
  }
  cache = null;
  return getSettings();
}

export function appStatus(): AppStatus {
  const { labels: _labels, ...s } = getSettings();
  return { ...s, publicUrl: config.publicUrl, transcription: !!config.transcribeKey };
}

export function resetSettingsCache() {
  cache = null;
}
