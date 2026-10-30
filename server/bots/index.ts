import { registerBuiltin } from './builtin.js';
import { seedBuiltinBots } from './manage.js';
import { grantPremium, premiumbot } from './premiumbot.js';
import { weatherbot } from './weatherbot.js';
import { importWeatherSeed } from './weatherImport.js';
import { installBotHooks } from './updates.js';
import { registerPaidHook } from './wallet.js';

export { startBotTimer } from './updates.js';
export { startWeatherTimer } from './weatherbot.js';

/** Bots start with the messenger: the hooks that tell them about chats, the built-in bots. */
export async function initBots() {
  installBotHooks();
  registerBuiltin('premiumbot', premiumbot);
  registerBuiltin('weatherbot', weatherbot);
  registerPaidHook('premiumbot', grantPremium);
  await seedBuiltinBots();
  importWeatherSeed();
}
