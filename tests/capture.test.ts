import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VoiceConnection } from '@discordjs/voice';
import { AudioCapture } from '../src/audio/capture.js';
import { OpusDecoder } from '../src/audio/opus.js';
import { Store } from '../src/storage/store.js';
import { parseConfig } from '../src/config/index.js';
import { session } from './helpers.js';

it('decodes simultaneous speakers individually and flushes late joiners and departed members', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-test-'));
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  store.saveSession(session());
  const streams = new Map<string, PassThrough>();
  const connection = {
    receiver: {
      subscribe: (id: string) => {
        const stream = new PassThrough({ objectMode: true });
        streams.set(id, stream);
        return stream;
      },
    },
  } as unknown as VoiceConnection;
  const failure = vi.fn();
  const capture = new AudioCapture(
    connection,
    'session-1',
    parseConfig({ dataDirectory: directory }),
    store,
    () => {},
    failure,
  );
  const members = ['a', 'b', 'c', 'late'].map((userId) => ({
    userId,
    displayName: userId,
    username: userId,
  }));
  try {
    capture.update(members.slice(0, 3));
    const encoder = new OpusDecoder(48000, 2);
    const packet = encoder.encode(Buffer.alloc(3840, 1));
    for (const id of ['a', 'b', 'c']) streams.get(id)!.write(packet);
    capture.update(members.slice(1)); // Flush departed a, subscribe late.
    streams.get('late')!.write(packet);
    await capture.stop();
    expect(failure).not.toHaveBeenCalled();
    expect(store.participants('session-1').map((person) => person.userId)).toEqual([
      'a',
      'b',
      'c',
      'late',
    ]);
    expect(store.counts('session-1').pending).toBe(4);
    const job = store.nextJob()!;
    expect(job.durationMs).toBe(20);
    expect((await readFile(job.path)).length).toBe(3840);
  } finally {
    await capture.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it('reports a storage limit instead of silently losing buffered speech', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-limit-'));
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  store.saveSession(session());
  const stream = new PassThrough({ objectMode: true });
  const connection = { receiver: { subscribe: () => stream } } as unknown as VoiceConnection;
  const failure = vi.fn();
  const capture = new AudioCapture(
    connection,
    'session-1',
    parseConfig({ dataDirectory: directory, maxPendingAudioMegabytes: 0.001 }),
    store,
    () => {},
    failure,
  );
  capture.update([{ userId: 'a', displayName: 'A', username: 'a' }]);
  const encoder = new OpusDecoder(48000, 2);
  stream.write(encoder.encode(Buffer.alloc(3840, 1)));
  await expect(capture.stop()).rejects.toThrow('storage limit');
  expect(failure).toHaveBeenCalledOnce();
  store.close();
  await rm(directory, { recursive: true, force: true });
});
