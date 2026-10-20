import { OpusDecoder } from './opus.js';
import { EndBehaviorType, type VoiceConnection, type AudioReceiveStream } from '@discordjs/voice';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BotConfig } from '../config/index.js';
import type { Member } from '../shared/types.js';
import type { Store } from '../storage/store.js';
import { SpeakerChunker, type PcmChunk } from './chunker.js';

interface Speaker {
  stream: AudioReceiveStream;
  chunker: SpeakerChunker;
  timer?: NodeJS.Timeout;
}
export class AudioCapture {
  private speakers = new Map<string, Speaker>();
  private writes = new Set<Promise<void>>();
  private reservedBytes = 0;
  private stopped = false;
  private failed = false;
  private failure?: Error;
  private epoch = performance.now();
  constructor(
    private connection: VoiceConnection,
    private sessionId: string,
    private config: BotConfig,
    private store: Store,
    private queued: () => void,
    private onFailure: (error: Error) => void,
  ) {}
  update(members: Member[]) {
    if (this.stopped) return;
    const ids = new Set(members.map((member) => member.userId));
    for (const [id, speaker] of this.speakers)
      if (!ids.has(id)) {
        this.closeSpeaker(speaker);
        this.speakers.delete(id);
      }
    for (const member of members) {
      if (this.speakers.has(member.userId)) continue;
      const decoder = new OpusDecoder(48000, 2);
      const stream = this.connection.receiver.subscribe(member.userId, {
        end: { behavior: EndBehaviorType.Manual },
      });
      const chunker = new SpeakerChunker(this.config.chunkSeconds * 1000, (chunk) =>
        this.persist(member, chunk),
      );
      const speaker: Speaker = { stream, chunker };
      this.speakers.set(member.userId, speaker);
      stream.on('data', (packet: Buffer) => {
        if (this.stopped || !this.speakers.has(member.userId)) return;
        try {
          const pcm = decoder.decode(packet);
          this.store.participant(this.sessionId, member.userId, member.displayName);
          chunker.push(pcm, performance.now() - this.epoch);
          clearTimeout(speaker.timer);
          speaker.timer = setTimeout(() => chunker.flush(), this.config.silenceMilliseconds);
        } catch (error) {
          this.fail(error);
        }
      });
      stream.on('error', (error) => this.fail(error));
    }
  }
  async stop() {
    if (!this.stopped) {
      this.stopped = true;
      for (const speaker of this.speakers.values()) this.closeSpeaker(speaker);
      this.speakers.clear();
    }
    await Promise.all(this.writes);
    if (this.failure) throw this.failure;
  }
  private closeSpeaker(speaker: Speaker) {
    clearTimeout(speaker.timer);
    speaker.stream.destroy();
    speaker.chunker.flush();
  }
  private persist(member: Member, chunk: PcmChunk) {
    const max = this.config.maxPendingAudioMegabytes * 1024 * 1024;
    if (this.store.pendingBytes() + this.reservedBytes + chunk.pcm.length > max) {
      this.fail(new Error('Audio storage limit reached; the final chunk could not be saved.'));
      return;
    }
    this.reservedBytes += chunk.pcm.length;
    const id = randomUUID();
    const directory = join(this.config.dataDirectory, 'sessions', this.sessionId);
    const path = join(directory, `${id}.pcm`);
    const write = (async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(path, chunk.pcm, { flag: 'wx', mode: 0o600 });
      this.store.addJob({
        id,
        sessionId: this.sessionId,
        userId: member.userId,
        path,
        bytes: chunk.pcm.length,
        offsetMs: chunk.offsetMs,
        durationMs: chunk.durationMs,
      });
      this.queued();
    })()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.reservedBytes -= chunk.pcm.length;
        this.writes.delete(write);
      });
    this.writes.add(write);
  }
  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.failure = error instanceof Error ? error : new Error('Audio capture failed.');
    this.onFailure(this.failure);
  }
}
