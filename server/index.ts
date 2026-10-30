import os from 'node:os';
import { buildApp } from './app.js';
import { config } from './config.js';
import { startCleanupTimer, startExpiryTimer } from './services/messages.js';
import { startScheduledTimer } from './services/scheduled.js';
import { startReminderTimer } from './services/reminders.js';
import { startPollTimer } from './services/polls.js';
import { attachSocket } from './socket.js';
import { startPremiumBonusTimer } from './bank/bank.js';
import { startBotTimer, startWeatherTimer } from './bots/index.js';

const app = await buildApp({ logger: true });
attachSocket(app.server);
startPollTimer();
startCleanupTimer();
startExpiryTimer();
startScheduledTimer();
startReminderTimer();
startPremiumBonusTimer();
startBotTimer();
startWeatherTimer();
await app.listen({ port: config.port, host: config.host });

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${config.port}`);
if (!process.env.ADMIN_PASSWORD) {
  console.warn('\n  ⚠ ADMIN_PASSWORD не задан — у @admin пароль по умолчанию "admin12345". Смените его в настройках профиля.');
}
console.log(`\n  TimbaGram запущен:\n    http://localhost:${config.port}\n${lan.map((u) => `    ${u}`).join('\n')}\n`);
