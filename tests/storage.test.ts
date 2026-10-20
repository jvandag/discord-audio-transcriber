import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { session } from './helpers.js';
it('persists aliases and settings across reopening and isolates servers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'transcriber-store-'));
  const path = join(directory, 'bot.sqlite');
  const defaults = { model: 'base.en', language: 'en' };
  let store = new Store(path, defaults);
  store.setAlias('guild', 'user', 'Alice', 'editor');
  store.saveSettings('guild', { model: 'small', language: 'auto' });
  store.close();
  store = new Store(path, defaults);
  expect(store.alias('guild', 'user')).toBe('Alice');
  expect(store.alias('other', 'user')).toBeUndefined();
  expect(store.settings('guild')).toEqual({ model: 'small', language: 'auto' });
  expect(store.settings('other')).toEqual(defaults);
  store.setAlias('guild', 'user', null, 'editor');
  expect(store.alias('guild', 'user')).toBeUndefined();
  store.close();
  rmSync(directory, { recursive: true });
});
it('freezes transcript aliases at finalization, including departed speakers', () => {
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  const recording = session();
  store.saveSession(recording);
  store.participant(recording.id, 'user', 'Original');
  store.setAlias(recording.guildId, 'user', 'First', 'editor');
  store.snapshotNames(recording);
  store.setAlias(recording.guildId, 'user', 'Later', 'editor');
  store.snapshotNames(recording);
  expect(store.participants(recording.id)[0]?.transcriptName).toBe('First');
  store.close();
});
it('recovers interrupted recordings and in-flight jobs without resuming capture', () => {
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  const recording = session();
  store.saveSession(recording);
  store.addJob({
    id: 'job',
    sessionId: recording.id,
    userId: 'user',
    offsetMs: 200,
    durationMs: 1000,
    path: '/tmp/missing.pcm',
    bytes: 20,
  });
  store.beginJob('job');
  store.recover();
  expect(store.session(recording.id).state).toBe('interrupted');
  expect(store.nextJob()?.attempts).toBe(1);
  expect(store.counts(recording.id).pending).toBe(1);
  store.close();
});
