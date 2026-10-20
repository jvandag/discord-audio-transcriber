import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
export const languageCodes = new Set(
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue auto'.split(
    ' ',
  ),
);
const schema = z.object({
  aliasPermissions: z.enum(['anyone', 'self', 'manage-guild']).default('anyone'),
  defaultModel: z.string().default('base.en'),
  defaultLanguage: z.string().default('en'),
  allowedLanguages: z.array(z.string()).min(1).default(['en', 'auto']),
  dataDirectory: z.string().default('data'),
  modelsDirectory: z.string().default('models'),
  whisperThreads: z.number().int().min(1).max(64).default(4),
  chunkSeconds: z.number().min(5).max(30).default(20),
  silenceMilliseconds: z.number().int().min(200).max(3000).default(800),
  maxPendingAudioMegabytes: z.number().positive().default(2048),
  transcriptionTimeoutSeconds: z.number().int().positive().default(600),
  retentionHours: z.number().positive().default(24),
});
export type BotConfig = z.infer<typeof schema>;
export function parseConfig(input: unknown): BotConfig {
  const config = schema.parse(input);
  for (const language of [...config.allowedLanguages, config.defaultLanguage]) {
    if (!languageCodes.has(language)) throw new Error(`Unknown Whisper language code: ${language}`);
  }
  if (!config.allowedLanguages.includes(config.defaultLanguage))
    throw new Error('defaultLanguage must be in allowedLanguages');
  return config;
}
export function loadConfig(): BotConfig {
  return parseConfig(
    JSON.parse(readFileSync(resolve(process.env.BOT_CONFIG_PATH ?? 'config/bot.json'), 'utf8')),
  );
}
export function credentials() {
  return z
    .object({ DISCORD_TOKEN: z.string().min(1), DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/) })
    .parse(process.env);
}
export const whisperPath = () =>
  resolve(process.env.WHISPER_CLI_PATH ?? 'vendor/whisper.cpp/build/bin/whisper-cli');
export function ffmpegPath(): string {
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string | null;
  const path = process.env.FFMPEG_PATH ?? ffmpeg;
  if (!path) throw new Error('FFmpeg is unavailable; set FFMPEG_PATH.');
  return path;
}
