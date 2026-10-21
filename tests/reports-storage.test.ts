import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { snapshotReportInput } from '../src/reports/input.js';
import { session } from './helpers.js';
import { reportJob } from './reports-helpers.js';

it('persists immutable input, current template, jobs and transcript message IDs across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reports-storage-'));
  const path = join(directory, 'bot.sqlite');
  const defaults = { model: 'base.en', language: 'en' };
  let store = new Store(path, defaults);
  try {
    const recording = session({
      state: 'completed',
      delivered: true,
      warnings: ['Connection interrupted.'],
    });
    store.saveSession(recording);
    store.participant(recording.id, 'user', 'Original');
    store.setAlias(recording.guildId, 'user', 'Alex', 'editor');
    store.snapshotNames(recording);
    const chunk = {
      id: 'job',
      sessionId: recording.id,
      userId: 'user',
      offsetMs: 0,
      durationMs: 1000,
      path: '/tmp/unused.pcm',
      bytes: 0,
      attempts: 0,
    };
    store.addJob(chunk);
    store.finishJob(chunk, [
      { userId: 'user', startMs: 0, endMs: 1000, text: 'The board might arrive Friday.' },
    ]);
    const snapshot = snapshotReportInput(store, recording);
    expect(snapshot.speakers).toEqual([{ id: 'speaker_1', name: 'Alex' }]);
    expect(JSON.stringify(snapshot)).not.toContain('"user"');
    store.setAlias(recording.guildId, 'user', 'Changed later', 'editor');
    expect(snapshotReportInput(store, recording)).toEqual(snapshot);
    const job = reportJob();
    store.createReport(job);
    store.saveTranscriptMessage(recording.id, 0, 'discord-message');
    expect(store.createReport({ ...job, id: 'duplicate' })).toBe(false);
    store.close();
    store = new Store(path, defaults);
    expect(store.reportInput(recording.id)).toEqual(snapshot);
    expect(store.report(recording.id)?.template?.text).toBe(job.template!.text);
    expect(store.lastTranscriptMessage(recording.id)).toBe('discord-message');
    expect(store.alias(recording.guildId, 'user')).toBe('Changed later');
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
it('disambiguates duplicate aliases using internal labels instead of exposing Discord IDs', () => {
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  try {
    const recording = session();
    store.saveSession(recording);
    store.participant(recording.id, 'one', 'Alex');
    store.participant(recording.id, 'two', 'Alex');
    const snapshot = snapshotReportInput(store, recording);
    expect(snapshot.speakers.map((speaker) => speaker.name)).toEqual([
      'Alex (speaker_1)',
      'Alex (speaker_2)',
    ]);
  } finally {
    store.close();
  }
});
