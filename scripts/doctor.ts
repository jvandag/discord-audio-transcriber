import { generateDependencyReport } from '@discordjs/voice';
import { OpusDecoder } from '../src/audio/opus.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { loadConfig, ffmpegPath, whisperPath } from '../src/config/index.js';
import { runProcess } from '../src/shared/process.js';
import { installedModel, validateLanguage } from '../src/transcription/models.js';
const config = loadConfig();
console.log(generateDependencyReport());
new OpusDecoder(48000, 2);
validateLanguage(config.defaultModel, config.defaultLanguage, config.allowedLanguages);
await access(whisperPath(), constants.X_OK);
await runProcess(whisperPath(), ['--help']);
await runProcess(ffmpegPath(), ['-version']);
console.log(`Default model: ${await installedModel(config.modelsDirectory, config.defaultModel)}`);
console.log(
  'Opus, DAVE dependencies, FFmpeg, Whisper, and default configuration are ready. Discord credentials and live reception require a separate live test.',
);
