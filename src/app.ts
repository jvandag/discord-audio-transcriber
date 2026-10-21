import { Client, GatewayIntentBits } from 'discord.js';
import { join } from 'node:path';
import { loadConfig } from './config/index.js';
import { Store } from './storage/store.js';
import { DiscordGateway } from './discord/gateway.js';
import { SessionManager } from './sessions/manager.js';
import { TranscriptionQueue } from './transcription/queue.js';
import { WhisperTranscriber } from './transcription/whisper.js';
import { installInteractions } from './discord/interactions.js';
import { normalizeModel, validateLanguage } from './transcription/models.js';
import { ReportManager } from './reports/manager.js';
import { GoogleReportDocuments, googleDocsRequest } from './reports/google-docs.js';
import { AIReportGenerator } from './reports/providers.js';
import { DiscordReportNotifier } from './reports/discord.js';
export function createApp() {
  const config = loadConfig();
  normalizeModel(config.defaultModel);
  validateLanguage(config.defaultModel, config.defaultLanguage, config.allowedLanguages);
  const store = new Store(join(config.dataDirectory, 'bot.sqlite'), {
    model: normalizeModel(config.defaultModel),
    language: config.defaultLanguage,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    allowedMentions: { parse: [] },
  });
  const gateway = new DiscordGateway(client, config, store);
  const queue = new TranscriptionQueue(store, new WhisperTranscriber(config), (id) =>
    manager.jobChanged(id),
  );
  const manager = new SessionManager(config, store, queue, gateway);
  const reports = new ReportManager(
    config.reports,
    store,
    new GoogleReportDocuments(googleDocsRequest(config.reports.requestTimeoutSeconds)),
    new AIReportGenerator(),
    new DiscordReportNotifier(client, store),
  );
  installInteractions(client, config, store, manager, reports);
  return { client, store, manager, queue, reports };
}
