import { rm } from 'node:fs/promises';
import type { Store } from '../storage/store.js';
import type { Transcriber } from './whisper.js';
import { logger } from '../shared/logger.js';

export class TranscriptionQueue {
  private running?: Promise<void>;
  private paused = false;
  constructor(
    private store: Store,
    private transcriber: Transcriber,
    private changed: (sessionId: string) => void = () => {},
  ) {}
  kick() {
    if (this.running || this.paused) return;
    this.running = this.work()
      .catch((error) => logger.error({ err: error }, 'Transcription queue failed'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async idle() {
    this.kick();
    await this.running;
  }
  async shutdown() {
    this.paused = true;
    await this.running;
  }
  private async work() {
    for (let job = this.store.nextJob(); job && !this.paused; job = this.store.nextJob()) {
      this.store.beginJob(job.id);
      try {
        const result = await this.transcriber.transcribe(job, this.store.session(job.sessionId));
        this.store.finishJob(
          job,
          result.map((segment) => ({
            ...segment,
            userId: job.userId,
            startMs: segment.startMs + job.offsetMs,
            endMs: segment.endMs + job.offsetMs,
          })),
        );
        await rm(job.path, { force: true }).catch((error) =>
          logger.warn({ err: error, jobId: job.id }, 'Could not remove processed audio'),
        );
      } catch (error) {
        this.store.failJob(job);
        logger.warn({ err: error, jobId: job.id }, 'Transcription attempt failed');
      }
      this.changed(job.sessionId);
    }
  }
}
