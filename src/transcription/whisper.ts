import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { ffmpegPath, whisperPath, type BotConfig } from '../config/index.js';
import { runProcess } from '../shared/process.js';
import type { Job, Settings, SpeechSegment } from '../shared/types.js';
import { installedModel } from './models.js';

const resultSchema = z.object({
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number().nonnegative(), to: z.number().nonnegative() }),
      text: z.string(),
    }),
  ),
});
export function parseWhisper(input: unknown, durationMs: number): SpeechSegment[] {
  return resultSchema.parse(input).transcription.flatMap((segment) => {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    const startMs = Math.min(durationMs, segment.offsets.from);
    const endMs = Math.min(durationMs, segment.offsets.to);
    return text && endMs > startMs ? [{ text, startMs, endMs }] : [];
  });
}
export interface Transcriber {
  transcribe(job: Job, settings: Settings): Promise<SpeechSegment[]>;
}
export class WhisperTranscriber implements Transcriber {
  constructor(private config: BotConfig) {}
  async transcribe(job: Job, settings: Settings): Promise<SpeechSegment[]> {
    const wav = `${job.path}.wav`;
    const output = `${job.path}.result`;
    try {
      await runProcess(ffmpegPath(), [
        '-nostdin',
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-i',
        job.path,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wav,
      ]);
      await runProcess(
        whisperPath(),
        [
          '-m',
          await installedModel(this.config.modelsDirectory, settings.model),
          '-f',
          wav,
          '-l',
          settings.language,
          '-t',
          String(this.config.whisperThreads),
          '-oj',
          '-of',
          output,
          '-np',
          '-sns',
          '-ng',
        ],
        this.config.transcriptionTimeoutSeconds * 1000,
      );
      return parseWhisper(JSON.parse(await readFile(`${output}.json`, 'utf8')), job.durationMs);
    } finally {
      await Promise.all([wav, `${output}.json`].map((path) => rm(path, { force: true })));
    }
  }
}
