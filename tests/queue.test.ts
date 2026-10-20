import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage/store.js';
import { TranscriptionQueue } from '../src/transcription/queue.js';
import { session } from './helpers.js';
it('queues 25 distinct speakers and merges results by capture time, not job order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-test-'));
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  store.saveSession(session());
  let concurrent = 0;
  let maxConcurrent = 0;
  const transcribe = vi.fn(async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await Promise.resolve();
    concurrent--;
    return [{ text: 'Speech', startMs: 10, endMs: 100 }];
  });
  for (let i = 0; i < 25; i++) {
    const path = join(directory, `${i}.pcm`);
    await writeFile(path, 'audio');
    store.addJob({
      id: `job-${i}`,
      sessionId: 'session-1',
      userId: `user-${i}`,
      path,
      bytes: 5,
      offsetMs: (25 - i) * 100,
      durationMs: 200,
    });
  }
  const queue = new TranscriptionQueue(store, { transcribe });
  queue.kick();
  await queue.idle();
  expect(maxConcurrent).toBe(1);
  expect(transcribe).toHaveBeenCalledTimes(25);
  expect(store.counts('session-1')).toEqual({ pending: 0, done: 25, failed: 0 });
  expect(store.segments('session-1')[0]).toMatchObject({
    userId: 'user-24',
    startMs: 110,
    endMs: 200,
  });
  store.close();
  await rm(directory, { recursive: true });
});
it('bounds retries and records failed chunks without blocking later jobs', async () => {
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  store.saveSession(session());
  store.addJob({
    id: 'bad',
    sessionId: 'session-1',
    userId: 'a',
    path: '/tmp/no-such-audio',
    bytes: 5,
    offsetMs: 0,
    durationMs: 100,
  });
  const transcribe = vi.fn(async () => {
    throw new Error('Native tool failed');
  });
  const queue = new TranscriptionQueue(store, { transcribe });
  await queue.idle();
  expect(transcribe).toHaveBeenCalledTimes(2);
  expect(store.counts('session-1').failed).toBe(1);
  expect(store.counts('session-1').pending).toBe(0);
  store.close();
});
