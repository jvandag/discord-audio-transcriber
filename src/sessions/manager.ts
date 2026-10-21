import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../config/index.js';
import { whisperPath } from '../config/index.js';
import type { Store } from '../storage/store.js';
import type { TranscriptionQueue } from '../transcription/queue.js';
import type { Session } from '../shared/types.js';
import { installedModel, validateLanguage } from '../transcription/models.js';
import { renderTranscript } from '../transcripts/render.js';
import { snapshotReportInput } from '../reports/input.js';
import { logger } from '../shared/logger.js';
import { EmptyChannelTimer } from './empty-channel.js';
import type { CaptureHandle, RecordingGateway } from './ports.js';

interface Active {
  session: Session;
  capture?: CaptureHandle;
  empty: EmptyChannelTimer;
  stopping?: Promise<void>;
  flushed?: boolean;
}
export class SessionManager {
  private active = new Map<string, Active>();
  private starting = new Set<string>();
  private finalizing = new Map<string, Promise<void>>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  private edits = new Map<string, Promise<void>>();
  private closing = false;
  private maintenance?: NodeJS.Timeout;
  constructor(
    private config: BotConfig,
    private store: Store,
    private queue: TranscriptionQueue,
    private gateway: RecordingGateway,
  ) {}
  current(guildId: string) {
    return this.active.get(guildId)?.session;
  }
  async start(channelId: string, guildId: string): Promise<Session> {
    if (this.closing) throw new Error('The bot is shutting down.');
    if (this.active.has(guildId) || this.starting.has(guildId))
      throw new Error('This server already has a recording or is finishing one.');
    this.starting.add(guildId);
    let active: Active | undefined;
    try {
      const channel = await this.gateway.inspect(channelId);
      if (channel.guildId !== guildId) throw new Error('Voice channel belongs to another server.');
      const settings = this.store.settings(guildId);
      validateLanguage(settings.model, settings.language, this.config.allowedLanguages);
      await installedModel(this.config.modelsDirectory, settings.model);
      await access(whisperPath(), constants.X_OK);
      const session: Session = {
        id: randomUUID(),
        guildId,
        channelId,
        channelName: channel.name,
        messageId: null,
        startedAt: Date.now(),
        endedAt: null,
        state: 'connecting',
        reason: null,
        delivered: false,
        ...settings,
      };
      this.store.saveSession(session);
      const empty = new EmptyChannelTimer(
        () => this.gateway.members(channelId).length === 0,
        () => {
          void this.stop(session.id, 'Channel empty for 30 seconds.').catch((error) =>
            logger.error({ err: error }, 'Auto-stop failed'),
          );
        },
      );
      active = { session, empty };
      this.active.set(guildId, active);
      session.messageId = await this.gateway.sendControl(session);
      this.store.saveSession(session);
      active.capture = await this.gateway.capture(
        session,
        () => this.queue.kick(),
        (error) => {
          const current = this.active.get(guildId);
          if (current?.session.state === 'recording')
            void this.stop(session.id, `Recording interrupted: ${error.message}`).catch((err) =>
              logger.error({ err }, 'Failed to stop interrupted recording'),
            );
        },
        (message) => {
          session.warnings ??= [];
          session.warnings.push(message);
          this.store.saveSession(session);
        },
      );
      session.startedAt = Date.now();
      session.state = 'recording';
      this.store.saveSession(session);
      active.capture.update(this.gateway.members(channelId));
      empty.update();
      this.refresh(session.id);
      return session;
    } catch (error) {
      if (active) {
        await active.capture
          ?.stop()
          .catch((stopError) => logger.warn({ err: stopError }, 'Startup capture cleanup failed'));
        active.empty.clear();
        active.session.state = 'interrupted';
        active.session.endedAt = Date.now();
        active.session.reason = 'Unable to start recording.';
        this.store.saveSession(active.session);
        this.active.delete(guildId);
        this.refresh(active.session.id);
      }
      throw error;
    } finally {
      this.starting.delete(guildId);
    }
  }
  async stop(sessionId: string, reason: string): Promise<void> {
    const session = this.store.session(sessionId);
    const active = this.active.get(session.guildId);
    if (!active || active.session.id !== sessionId)
      throw new Error('This recording is no longer active.');
    if (active.stopping) return active.stopping;
    if (active.session.state !== 'recording') throw new Error('Recording is not ready to stop.');
    // Change state synchronously before awaiting file flushes; further interactions cannot race capture.
    active.session.state = 'finalizing';
    active.session.endedAt = Date.now();
    active.session.reason = reason;
    active.empty.clear();
    this.store.saveSession(active.session);
    this.refresh(sessionId);
    active.stopping = (async () => {
      try {
        await active.capture?.stop();
      } catch (error) {
        active.session.reason += ' Audio flush failed; some speech may be missing.';
        logger.error({ err: error, sessionId }, 'Audio flush failed');
      }
      this.store.snapshotNames(active.session);
      this.store.saveSession(active.session);
      active.flushed = true;
      this.queue.kick();
      this.refresh(sessionId);
      await this.tryFinalize(active.session);
    })();
    return active.stopping;
  }
  membershipChanged(guildId: string) {
    const active = this.active.get(guildId);
    if (!active || active.session.state !== 'recording') return;
    active.capture?.update(this.gateway.members(active.session.channelId));
    active.empty.update();
    this.refresh(active.session.id);
  }
  refresh(sessionId: string) {
    if (this.closing || this.refreshTimers.has(sessionId)) return;
    this.refreshTimers.set(
      sessionId,
      setTimeout(() => {
        this.refreshTimers.delete(sessionId);
        const previous = this.edits.get(sessionId) ?? Promise.resolve();
        const edit = previous
          .then(async () => {
            const session = this.store.session(sessionId);
            if (session.messageId)
              await this.gateway.updateControl(
                session,
                this.store.counts(sessionId),
                this.store.participants(sessionId).length,
              );
          })
          .catch((error) =>
            logger.warn({ err: error, sessionId }, 'Could not update recording controls'),
          );
        this.edits.set(sessionId, edit);
        void edit.finally(() => {
          if (this.edits.get(sessionId) === edit) this.edits.delete(sessionId);
        });
      }, 1000),
    );
  }
  jobChanged(sessionId: string) {
    if (this.closing) return;
    this.refresh(sessionId);
    const active = [...this.active.values()].find((item) => item.session.id === sessionId);
    // Wait until pending capture writes and the name snapshot are complete.
    void (active?.stopping ?? Promise.resolve())
      .then(() => this.tryFinalize(this.store.session(sessionId)))
      .catch((error) => logger.error({ err: error, sessionId }, 'Finalization failed'));
  }
  async recover() {
    this.store.recover();
    await this.cleanup();
    this.queue.kick();
    for (const session of this.store.sessions())
      if (session.state === 'finalizing' || session.state === 'interrupted')
        await this.tryFinalize(session);
    this.maintenance = setInterval(() => {
      this.queue.kick();
      for (const session of this.store.sessions())
        if (session.state === 'finalizing' || session.state === 'interrupted')
          void this.tryFinalize(session);
      void this.cleanup().catch((error) => logger.warn({ err: error }, 'Retention cleanup failed'));
    }, 60_000);
  }
  async retryDeliveries() {
    for (const session of this.store.sessions()) {
      if (!session.delivered && session.state !== 'recording' && session.state !== 'connecting')
        await this.tryFinalize(session);
    }
  }
  private tryFinalize(session: Session): Promise<void> {
    const existing = this.finalizing.get(session.id);
    if (existing) return existing;
    const capturing = this.active.get(session.guildId);
    if (capturing?.session.id === session.id && !capturing.flushed) return Promise.resolve();
    if (
      session.delivered ||
      !['finalizing', 'interrupted', 'completed'].includes(session.state) ||
      this.store.counts(session.id).pending
    )
      return Promise.resolve();
    const task = this.finalize(session).finally(() => this.finalizing.delete(session.id));
    this.finalizing.set(session.id, task);
    return task;
  }
  private async finalize(session: Session) {
    try {
      this.store.snapshotNames(session);
      snapshotReportInput(this.store, session);
      const text = renderTranscript(
        session,
        this.store.participants(session.id),
        this.store.segments(session.id),
        this.store.counts(session.id).failed,
      );
      const directory = join(this.config.dataDirectory, 'sessions', session.id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'transcript.txt'), text, { mode: 0o600 });
      await this.gateway.deliver(session, text);
      session.delivered = true;
      session.state = 'completed';
      this.store.saveSession(session);
      this.refresh(session.id);
    } catch (error) {
      logger.warn(
        { err: error, sessionId: session.id },
        'Transcript is saved locally; delivery will be retried',
      );
    } finally {
      const active = this.active.get(session.guildId);
      if (active?.session.id === session.id) this.active.delete(session.guildId);
    }
  }
  private async cleanup() {
    const before = Date.now() - this.config.retentionHours * 3_600_000;
    for (const session of this.store.sessions()) {
      if (
        !session.endedAt ||
        session.endedAt > before ||
        this.store.counts(session.id).pending ||
        this.active.has(session.guildId)
      )
        continue;
      const directory = join(this.config.dataDirectory, 'sessions', session.id);
      for (const file of await readdir(directory).catch(() => [])) {
        // Keep an undelivered transcript for operator recovery; expire failed audio and intermediates.
        if (!session.delivered && file === 'transcript.txt') continue;
        await rm(join(directory, file), { force: true });
      }
      this.store.releaseAudioBudget(session.id);
    }
  }
  async shutdown() {
    this.closing = true;
    clearInterval(this.maintenance);
    while (this.starting.size) await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all(
      [...this.active.values()]
        .filter((active) => active.session.state === 'recording')
        .map((active) => this.stop(active.session.id, 'Bot shutting down.')),
    );
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    await this.queue.shutdown();
    await Promise.all([...this.active.values()].map((active) => active.stopping));
    await Promise.all(this.finalizing.values());
    await Promise.all(this.edits.values());
  }
}
