import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Store } from '../storage/store.js';
import { configuredDestination, type ReportsConfig } from './config.js';
import { snapshotReportInput } from './input.js';
import { renderReport } from './schema.js';
import { filledTemplate } from './template.js';
import {
  ReportError,
  type ReportDocuments,
  type ReportGenerator,
  type ReportJob,
  type ReportNotifier,
} from './types.js';
import { logger } from '../shared/logger.js';

export class ReportManager {
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closing = false;
  constructor(
    private config: ReportsConfig,
    private store: Store,
    private documents: ReportDocuments,
    private generator: ReportGenerator,
    private notifier: ReportNotifier,
    private readGuidelines = (path: string) => readFile(path, 'utf8'),
  ) {}
  request(sessionId: string, requestedBy: string) {
    if (this.closing) throw new Error('The bot is shutting down.');
    const session = this.store.session(sessionId);
    const existing = this.store.report(sessionId);
    if (existing) return existing;
    const destination = configuredDestination(this.config, session.guildId);
    if (!session.delivered || session.state !== 'completed' || this.store.counts(sessionId).pending)
      throw new Error('Wait until the complete transcript has been delivered.');
    if (
      this.store
        .reports()
        .filter((job) => ['queued', 'generating', 'ready', 'publishing'].includes(job.state))
        .length >= this.config.maxQueuedJobs
    )
      throw new Error('The report queue is full. Try again later.');
    const input = snapshotReportInput(this.store, session);
    if (!input.segments.length)
      throw new Error('No usable speech was transcribed. A report cannot be generated.');
    const now = Date.now();
    const job: ReportJob = {
      id: randomUUID(),
      sessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      requestedBy,
      createdAt: now,
      updatedAt: now,
      state: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      options: structuredClone(this.config),
      destination: structuredClone(destination),
      inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      reviewIssues: [],
      notificationPending: true,
      usage: [],
    };
    this.store.createReport(job);
    this.kick();
    return this.store.report(sessionId)!;
  }
  retry(sessionId: string, requester: string) {
    if (!this.config.enabled) throw new Error('Meeting reports are disabled.');
    const job = this.store.report(sessionId);
    if (!job) return this.request(sessionId, requester);
    if (job.state !== 'failed')
      throw new Error(
        'Only failed reports can be retried. Existing or published reports are not regenerated.',
      );
    // A generated report always keeps its saved destination and format on publication retries.
    if (!job.draft) {
      job.options = structuredClone(this.config);
      job.destination = structuredClone(configuredDestination(this.config, job.guildId));
    }
    job.state = job.draft ? 'ready' : 'queued';
    job.attempts = 0;
    job.nextAttemptAt = 0;
    delete job.error;
    this.save(job);
    this.kick();
    return job;
  }
  approve(sessionId: string, requester: string) {
    if (!this.config.enabled) throw new Error('Meeting reports are disabled.');
    const job = this.store.report(sessionId);
    if (!job || job.state !== 'needs_review' || !job.draft)
      throw new Error('This report is not awaiting review.');
    // Factuality flags require correcting/regenerating the source, not a blind approval.
    if (job.reviewIssues.length)
      throw new Error(
        'The report has factuality issues. Review the draft and correct the source/template, then discard and regenerate it.',
      );
    job.approvedBy = requester;
    job.state = 'ready';
    job.attempts = 0;
    this.save(job);
    this.kick();
    return job;
  }
  discard(sessionId: string) {
    const job = this.store.report(sessionId);
    if (!job || !['needs_review', 'failed'].includes(job.state))
      throw new Error('Only unpublished drafts or failed reports can be discarded.');
    // An ambiguous publication must be reconciled rather than forgotten.
    if (job.draft && job.state === 'failed' && job.attempts)
      throw new Error('Retry publication first to reconcile a possible Google Docs write.');
    job.state = 'discarded';
    this.save(job);
    return job;
  }
  regenerate(sessionId: string, requester: string) {
    const job = this.store.report(sessionId);
    if (!job || job.state !== 'discarded')
      throw new Error('Discard the unpublished draft before regenerating it.');
    const target = configuredDestination(this.config, job.guildId);
    job.id = randomUUID();
    job.requestedBy = requester;
    job.options = structuredClone(this.config);
    job.destination = structuredClone(target);
    job.state = 'queued';
    job.attempts = 0;
    job.nextAttemptAt = 0;
    job.reviewIssues = [];
    delete job.draft;
    delete job.rendered;
    delete job.filledTemplate;
    delete job.template;
    delete job.guidelines;
    delete job.approvedBy;
    delete job.error;
    this.save(job);
    this.kick();
    return job;
  }
  recover() {
    if (!this.config.enabled) return;
    for (const job of this.store.reports()) {
      if (job.state === 'generating') job.state = 'queued';
      if (job.state === 'publishing') job.state = 'ready';
      this.store.saveReport(job);
    }
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
    this.kick();
  }
  kick() {
    if (this.closing || !this.config.enabled || this.running) return;
    this.running = this.drain()
      .catch(() => logger.warn('Report worker failed; saved jobs can be retried.'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async idle() {
    await this.running;
  }
  private save(job: ReportJob) {
    job.updatedAt = Date.now();
    job.notificationPending = true;
    this.store.saveReport(job);
  }
  private async notify(job: ReportJob) {
    try {
      await this.notifier.update(job);
      const current = this.store.report(job.sessionId)!;
      if (current.id !== job.id) return;
      current.notificationMessageId = job.notificationMessageId;
      if (current.updatedAt === job.updatedAt && current.state === job.state)
        current.notificationPending = false;
      this.store.saveReport(current);
    } catch {
      logger.warn(
        { sessionId: job.sessionId },
        'Could not update report controls; notification will be retried.',
      );
    }
  }
  private async drain() {
    for (const initial of this.store.reports()) {
      if (this.closing) break;
      const job = this.store.report(initial.sessionId)!;
      if (job.notificationPending) await this.notify(job);
      if (!['queued', 'ready'].includes(job.state) || job.nextAttemptAt > Date.now()) continue;
      try {
        const input = this.store.reportInput(job.sessionId);
        if (
          !input ||
          createHash('sha256').update(JSON.stringify(input)).digest('hex') !== job.inputHash
        )
          throw new ReportError(
            'The frozen transcript is missing or changed. Nothing was appended.',
          );
        if (!job.draft) {
          job.state = 'generating';
          job.attempts++;
          this.save(job);
          await this.notify(job);
          // Fetch EVERY time generation is attempted. Never fall back to a cached format.
          job.template = await this.documents.readTemplate(job.destination);
          job.guidelines = await this.readGuidelines(job.options.guidelinesPath);
          this.save(job);
          const result = await this.generator.generate(job, input, () =>
            this.store.saveReport(job),
          );
          job.draft = result.draft;
          job.reviewIssues = result.issues;
          if (job.template.layout) job.filledTemplate = filledTemplate(job, input);
          job.rendered = renderReport(job, input);
          job.attempts = 0;
          job.nextAttemptAt = 0;
          delete job.error;
          job.state =
            result.issues.length || job.options.publicationMode === 'review'
              ? 'needs_review'
              : 'ready';
          this.save(job);
          await this.notify(job);
        }
        if (job.state === 'ready') {
          job.state = 'publishing';
          job.attempts++;
          this.save(job);
          await this.notify(job);
          job.documentUrl = await this.documents.append(job);
          job.state = 'published';
          job.publishedAt = Date.now();
          delete job.error;
          this.save(job);
          await this.notify(job);
        }
      } catch (error) {
        job.error =
          error instanceof ReportError
            ? error.message
            : 'The report operation failed. Check credentials, document access, guidelines, and configuration before retrying.';
        const retry =
          error instanceof ReportError && error.retryable && job.attempts < job.options.maxAttempts;
        job.state = retry ? (job.draft ? 'ready' : 'queued') : 'failed';
        job.nextAttemptAt = retry ? Date.now() + 15000 * 2 ** Math.max(0, job.attempts - 1) : 0;
        this.save(job);
        await this.notify(job);
      }
    }
  }
  async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    await this.running;
  }
}
