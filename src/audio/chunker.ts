export const PCM_BYTES_PER_MS = 48 * 2 * 2;
export interface PcmChunk {
  pcm: Buffer;
  offsetMs: number;
  durationMs: number;
}

/** Each speaker has their own clock. Short discontinuities retain silence in the WAV timeline. */
export class SpeakerChunker {
  private buffers: Buffer[] = [];
  private bytes = 0;
  private offsetMs = 0;
  constructor(
    private maxMilliseconds: number,
    private emit: (chunk: PcmChunk) => void,
  ) {}
  push(pcm: Buffer, receivedMs: number) {
    const duration = pcm.length / PCM_BYTES_PER_MS;
    const packetStart = Math.max(0, receivedMs - duration);
    if (!this.bytes) this.offsetMs = packetStart;
    const gap = packetStart - (this.offsetMs + this.bytes / PCM_BYTES_PER_MS);
    // Arrival timestamps cannot recover original sender timestamps, but do preserve substantial gaps.
    if (gap > 120) {
      if (gap > 1000 || this.bytes / PCM_BYTES_PER_MS + gap + duration > this.maxMilliseconds) {
        this.flush();
        this.offsetMs = packetStart;
      } else {
        const silence = Buffer.alloc(Math.round(gap * 48) * 4);
        this.buffers.push(silence);
        this.bytes += silence.length;
      }
    }
    if (this.bytes && (this.bytes + pcm.length) / PCM_BYTES_PER_MS > this.maxMilliseconds) {
      const nextOffset = this.offsetMs + this.bytes / PCM_BYTES_PER_MS;
      this.flush();
      this.offsetMs = Math.max(nextOffset, packetStart);
    }
    // Ignore true zero-only input when a chunk has not started.
    if (!this.bytes && pcm.every((byte) => byte === 0)) return;
    this.buffers.push(Buffer.from(pcm));
    this.bytes += pcm.length;
  }
  flush() {
    if (!this.bytes) return;
    const chunk = {
      pcm: Buffer.concat(this.buffers, this.bytes),
      offsetMs: this.offsetMs,
      durationMs: this.bytes / PCM_BYTES_PER_MS,
    };
    this.buffers = [];
    this.bytes = 0;
    this.emit(chunk);
  }
}
