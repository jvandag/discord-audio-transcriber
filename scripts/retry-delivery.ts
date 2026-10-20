import { Events } from 'discord.js';
import { createApp } from '../src/app.js';
import { credentials } from '../src/config/index.js';
const app = createApp();
const ready = new Promise<void>((resolve) => app.client.once(Events.ClientReady, () => resolve()));
try {
  await app.client.login(credentials().DISCORD_TOKEN);
  await ready;
  await app.manager.retryDeliveries();
} finally {
  app.client.destroy();
  app.store.close();
}
