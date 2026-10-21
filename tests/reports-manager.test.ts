import { afterEach, expect, it, vi } from 'vitest';
import { ReportManager } from '../src/reports/manager.js';
import { ReportError, type ReportJob } from '../src/reports/types.js';
import type { ReportsConfig } from '../src/reports/config.js';
import { session } from './helpers.js';
import { reportOptions, reportStore, reportDraft, template } from './reports-helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
  vi.useRealTimers();
});
function harness(options: Partial<ReportsConfig> = {}) {
  const config = { ...reportOptions(), ...options };
  const store = reportStore();
  const documents = {
    readTemplate: vi.fn(async () => template()),
    append: vi.fn(async (_job: ReportJob) => 'https://docs.google.com/document/d/log/edit'),
  };
  const generator = {
    generate: vi.fn(async () => ({ draft: structuredClone(reportDraft), issues: [] as string[] })),
  };
  const notifier = { update: vi.fn(async (_job: ReportJob) => {}) };
  const manager = new ReportManager(
    config,
    store,
    documents,
    generator,
    notifier,
    async () => 'Preserve meaning.',
  );
  cleanup.push(async () => {
    await manager.shutdown();
    store.close();
  });
  return { manager, store, documents, generator, notifier, config };
}
it('deduplicates repeated clicks, fetches the live format, then appends once', async () => {
  const { manager, store, documents, generator } = harness();
  const first = manager.request('session-1', 'editor');
  expect(manager.request('session-1', 'other').id).toBe(first.id);
  await manager.idle();
  expect(documents.readTemplate).toHaveBeenCalledOnce();
  expect(generator.generate).toHaveBeenCalledOnce();
  expect(documents.append).toHaveBeenCalledOnce();
  expect(store.report('session-1')).toMatchObject({ state: 'published', requestedBy: 'editor' });
  manager.request('session-1', 'third');
  await manager.idle();
  expect(documents.append).toHaveBeenCalledOnce();
});
it('fetches a changed template for each new meeting and after regeneration', async () => {
  const { manager, store, documents, generator } = harness({ publicationMode: 'review' });
  documents.readTemplate
    .mockResolvedValueOnce(template('Old format'))
    .mockResolvedValueOnce(template('New format'))
    .mockResolvedValueOnce(template('Latest format'));
  manager.request('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')?.template?.text).toBe('Old format');
  store.saveSession(session({ id: 'session-2', state: 'completed', delivered: true }));
  const input = store.reportInput('session-1')!;
  store.saveReportInput({ ...input, sessionId: 'session-2' });
  manager.request('session-2', 'editor');
  await manager.idle();
  expect(store.report('session-2')?.template?.text).toBe('New format');
  const priorId = store.report('session-1')!.id;
  manager.discard('session-1');
  manager.regenerate('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')).toMatchObject({
    state: 'needs_review',
    template: { text: 'Latest format' },
  });
  expect(store.report('session-1')?.id).not.toBe(priorId);
  expect(generator.generate).toHaveBeenCalledTimes(3);
  expect(documents.append).not.toHaveBeenCalled();
});
it('never uses an old template when a fresh fetch fails', async () => {
  const { manager, store, documents, generator } = harness({ publicationMode: 'review' });
  manager.request('session-1', 'editor');
  await manager.idle();
  manager.discard('session-1');
  documents.readTemplate.mockRejectedValueOnce(new ReportError('Template access revoked.'));
  manager.regenerate('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('failed');
  expect(generator.generate).toHaveBeenCalledOnce();
  expect(documents.append).not.toHaveBeenCalled();
});
it('retries publication using the saved draft without another generation or format fetch', async () => {
  const { manager, store, documents, generator } = harness();
  documents.append.mockRejectedValueOnce(new ReportError('Log access revoked.'));
  manager.request('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('failed');
  manager.retry('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('published');
  expect(documents.readTemplate).toHaveBeenCalledOnce();
  expect(generator.generate).toHaveBeenCalledOnce();
});
it('holds factuality flags and does not allow blind approval', async () => {
  const { manager, store, documents, generator } = harness();
  generator.generate.mockResolvedValueOnce({
    draft: reportDraft,
    issues: ['Conditional deadline was changed.'],
  });
  manager.request('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('needs_review');
  expect(() => manager.approve('session-1', 'editor')).toThrow('factuality issues');
  expect(documents.append).not.toHaveBeenCalled();
});
it('supports explicit approval of a clean draft in review mode', async () => {
  const { manager, store, documents } = harness({ publicationMode: 'review' });
  manager.request('session-1', 'editor');
  await manager.idle();
  expect(documents.append).not.toHaveBeenCalled();
  manager.approve('session-1', 'reviewer');
  await manager.idle();
  expect(store.report('session-1')).toMatchObject({ state: 'published', approvedBy: 'reviewer' });
});
it('preserves an approval that occurs while a notification is in flight', async () => {
  const { manager, store, notifier } = harness({ publicationMode: 'review' });
  notifier.update.mockImplementation(async (job) => {
    if (job.state === 'needs_review') manager.approve(job.sessionId, 'reviewer');
  });
  manager.request('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('ready');
  manager.kick();
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('published');
});
it('bounds transient retries with backoff and preserves a failed job', async () => {
  const { manager, store, documents } = harness({ maxAttempts: 2 });
  documents.readTemplate.mockRejectedValue(new ReportError('Service unavailable.', true));
  manager.request('session-1', 'editor');
  await manager.idle();
  expect(store.report('session-1')).toMatchObject({ state: 'queued', attempts: 1 });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60000);
  manager.kick();
  await manager.idle();
  expect(store.report('session-1')).toMatchObject({ state: 'failed', attempts: 2 });
  manager.kick();
  await manager.idle();
  expect(documents.readTemplate).toHaveBeenCalledTimes(2);
});
it('recovers an interrupted publication without regenerating the saved report', async () => {
  const { manager, store, documents, generator } = harness({ publicationMode: 'review' });
  manager.request('session-1', 'editor');
  await manager.idle();
  const job = store.report('session-1')!;
  job.state = 'publishing';
  store.saveReport(job);
  manager.recover();
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('published');
  expect(documents.append).toHaveBeenCalledOnce();
  expect(generator.generate).toHaveBeenCalledOnce();
});
it('clears a transient error when generation later succeeds and awaits review', async () => {
  const { manager, store, documents } = harness({ publicationMode: 'review' });
  documents.readTemplate.mockRejectedValueOnce(new ReportError('Temporary outage.', true));
  manager.request('session-1', 'editor');
  await manager.idle();
  const job = store.report('session-1')!;
  expect(job.error).toBe('Temporary outage.');
  job.nextAttemptAt = 0;
  store.saveReport(job);
  manager.kick();
  await manager.idle();
  expect(store.report('session-1')?.state).toBe('needs_review');
  expect(store.report('session-1')?.error).toBeUndefined();
});
it('rejects empty, undelivered, and unconfigured report requests', () => {
  const { manager, store } = harness();
  store.saveSession(session({ delivered: false }));
  expect(() => manager.request('session-1', 'editor')).toThrow('complete transcript');
  store.saveSession(session({ state: 'completed', delivered: true, guildId: 'other' }));
  expect(() => manager.request('session-1', 'editor')).toThrow('Configure this server');
  store.saveSession(session({ id: 'empty', state: 'completed', delivered: true }));
  expect(() => manager.request('empty', 'editor')).toThrow('No usable speech');
});
