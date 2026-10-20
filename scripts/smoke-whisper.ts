import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ffmpegPath, loadConfig } from '../src/config/index.js';
import { runProcess } from '../src/shared/process.js';
import { WhisperTranscriber } from '../src/transcription/whisper.js';
import { normalizeModel } from '../src/transcription/models.js';

const config = loadConfig();
const model = normalizeModel(process.argv[2] ?? config.defaultModel);
const sample = resolve(process.argv[3] ?? 'vendor/whisper.cpp/samples/jfk.wav');
const directory = await mkdtemp(join(tmpdir(), 'whisper-smoke-'));
const path = join(directory, 'audio.pcm');
try {
  await runProcess(ffmpegPath(), [
    '-nostdin',
    '-y',
    '-i',
    sample,
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    path,
  ]);
  const bytes = (await stat(path)).size;
  const durationMs = bytes / 192;
  const start = performance.now();
  const result = await new WhisperTranscriber(config).transcribe(
    {
      id: 'smoke',
      sessionId: 'smoke',
      userId: 'sample',
      path,
      bytes,
      offsetMs: 0,
      durationMs,
      attempts: 0,
    },
    { model, language: model.endsWith('.en') ? 'en' : config.defaultLanguage },
  );
  if (!result.length || !result.every((segment) => segment.endMs > segment.startMs))
    throw new Error('No valid speech segments returned.');
  if (
    !process.argv[3] &&
    !result
      .map((segment) => segment.text)
      .join(' ')
      .toLowerCase()
      .includes('country')
  )
    throw new Error('The sample transcription did not contain the expected speech.');
  console.log(
    JSON.stringify(
      {
        model,
        audioSeconds: durationMs / 1000,
        processingSeconds: (performance.now() - start) / 1000,
        segments: result.length,
        success: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
