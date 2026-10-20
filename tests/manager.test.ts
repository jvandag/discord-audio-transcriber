import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/index.js';
import { Store } from '../src/storage/store.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TranscriptionQueue } from '../src/transcription/queue.js';
import type { RecordingGateway } from '../src/sessions/ports.js';
import type { Session } from '../src/shared/types.js';
import { session } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'manager-test-'));
  const models = join(directory, 'models');
  await mkdir(models);
  await writeFile(join(models, 'ggml-base.en.bin'), 'test');
  vi.stubEnv('WHISPER_CLI_PATH', process.execPath);
  const config = parseConfig({ dataDirectory: directory, modelsDirectory: models });
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  let members = [{ userId: 'alice', displayName: 'Alice', username: 'alice' }];
  const stopCapture = vi.fn(async () => {});
  const deliver = vi.fn(async (_session: Session, _transcript: string) => {});
  const gateway: RecordingGateway = {
    inspect: vi.fn(async (channelId) => ({ id: channelId, guildId: 'guild', name: 'General' })),
    members: () => members,
    capture: vi.fn(async () => ({ update: vi.fn(), stop: stopCapture })),
    sendControl: vi.fn(async () => 'message'),
    updateControl: vi.fn(async () => {}),
    deliver,
  };
  const queue = new TranscriptionQueue(store, { transcribe: async () => [] });
  const manager = new SessionManager(config, store, queue, gateway);
  cleanup.push(async () => {
    await manager.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    manager,
    store,
    gateway,
    stopCapture,
    deliver,
    setMembers: (value: typeof members) => {
      members = value;
    },
  };
}
it('reserves the server during startup and finalizes capture only once', async () => {
  const { manager, stopCapture, deliver } = await setup();
  const first = manager.start('voice', 'guild');
  await expect(manager.start('voice', 'guild')).rejects.toThrow('already');
  const recording = await first;
  await Promise.all([
    manager.stop(recording.id, 'Manual stop'),
    manager.stop(recording.id, 'Repeated stop'),
  ]);
  expect(stopCapture).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledOnce();
});
it('cancels the empty-channel countdown if a participant returns', async () => {
  const { manager, stopCapture, setMembers } = await setup();
  await manager.start('voice', 'guild');
  vi.useFakeTimers();
  setMembers([]);
  manager.membershipChanged('guild');
  await vi.advanceTimersByTimeAsync(29_000);
  setMembers([{ userId: 'bob', displayName: 'Bob', username: 'bob' }]);
  manager.membershipChanged('guild');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(stopCapture).not.toHaveBeenCalled();
  setMembers([]);
  manager.membershipChanged('guild');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(stopCapture).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
it('snapshots settings and keeps aliases consistent across the final transcript', async () => {
  const { manager, store, deliver } = await setup();
  const recording = await manager.start('voice', 'guild');
  store.saveSettings('guild', { model: 'small', language: 'auto' });
  store.participant(recording.id, 'alice', 'Alice');
  store.setAlias('guild', 'alice', 'Insert Name', 'editor');
  await manager.stop(recording.id, 'Manual stop');
  expect(store.session(recording.id)).toMatchObject({
    model: 'base.en',
    language: 'en',
    delivered: true,
  });
  expect(deliver.mock.calls[0]?.[1]).toContain('Insert Name');
});
it('retains an undelivered transcript and permits retry', async () => {
  const { manager, store, deliver } = await setup();
  deliver.mockRejectedValueOnce(new Error('Upload rejected'));
  const recording = await manager.start('voice', 'guild');
  await manager.stop(recording.id, 'Manual stop');
  expect(store.session(recording.id).delivered).toBe(false);
  await manager.retryDeliveries();
  expect(store.session(recording.id).delivered).toBe(true);
});
it('does not deliver before the final capture write is flushed', async () => {
  const { manager, stopCapture, deliver } = await setup();
  let resolveFlush!: () => void;
  stopCapture.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveFlush = resolve;
      }),
  );
  const recording = await manager.start('voice', 'guild');
  const stopping = manager.stop(recording.id, 'Manual stop');
  manager.jobChanged(recording.id);
  await Promise.resolve();
  expect(deliver).not.toHaveBeenCalled();
  resolveFlush();
  await stopping;
  expect(deliver).toHaveBeenCalledOnce();
});
it('recovers interrupted sessions without starting voice capture', async () => {
  const { manager, store, gateway, deliver } = await setup();
  store.saveSession(session({ guildId: 'guild' }));
  await manager.recover();
  expect(gateway.capture).not.toHaveBeenCalled();
  expect(deliver).toHaveBeenCalledOnce();
  expect(store.session('session-1').reason).toContain('interrupted');
});
