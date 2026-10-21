import { Events } from 'discord.js';
import { createApp } from './app.js';
import { credentials } from './config/index.js';
import { logger } from './shared/logger.js';
const auth = credentials();
const { client, manager, store, reports } = createApp();
client.once(Events.ClientReady, () => {
  logger.info({ botId: client.user?.id }, 'Bot ready');
  void manager.recover().catch((error) => logger.error({ err: error }, 'Session recovery failed'));
  reports.recover();
});
client.on(Events.Error, (error) => logger.error({ err: error }, 'Discord client error'));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Stopping capture and saving pending work');
  try {
    const results = await Promise.allSettled([manager.shutdown(), reports.shutdown()]);
    for (const result of results)
      if (result.status === 'rejected')
        logger.error('A shutdown operation failed; persisted jobs will be recovered on restart.');
  } finally {
    client.destroy();
    store.close();
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
await client.login(auth.DISCORD_TOKEN);
