import { describe, expect, it } from 'vitest';
import { SpeakerChunker, PCM_BYTES_PER_MS, type PcmChunk } from '../src/audio/chunker.js';
import { parseWhisper } from '../src/transcription/whisper.js';
import { renderTranscript, splitTranscript, timestamp } from '../src/transcripts/render.js';
import { session } from './helpers.js';
const frame = (ms: number) => Buffer.alloc(PCM_BYTES_PER_MS * ms, 1);
describe('speaker audio timing', () => {
  it('preserves gaps and flushes final speech', () => {
    const output: PcmChunk[] = [];
    const chunker = new SpeakerChunker(1000, (chunk) => output.push(chunk));
    chunker.push(frame(20), 120);
    chunker.push(frame(20), 340);
    chunker.flush();
    expect(output[0]?.offsetMs).toBe(100);
    expect(output[0]?.durationMs).toBe(240);
    expect(
      output[0]?.pcm
        .subarray(20 * PCM_BYTES_PER_MS, 220 * PCM_BYTES_PER_MS)
        .every((value) => value === 0),
    ).toBe(true);
  });
  it('splits continuous speech and tracks each speaker independently', () => {
    const a: PcmChunk[] = [];
    const b: PcmChunk[] = [];
    const alice = new SpeakerChunker(100, (chunk) => a.push(chunk));
    const bob = new SpeakerChunker(100, (chunk) => b.push(chunk));
    for (let time = 20; time <= 160; time += 20) {
      alice.push(frame(20), time);
      bob.push(frame(20), time + 100);
    }
    alice.flush();
    bob.flush();
    expect(a.map((chunk) => chunk.durationMs)).toEqual([100, 60]);
    expect(a[1]?.offsetMs).toBe(100);
    expect(b[0]?.offsetMs).toBe(100);
  });
  it('does not turn long pauses into hours of zero buffers', () => {
    const output: PcmChunk[] = [];
    const chunker = new SpeakerChunker(20_000, (chunk) => output.push(chunk));
    chunker.push(frame(20), 20);
    chunker.push(frame(20), 3_600_020);
    chunker.flush();
    expect(output).toHaveLength(2);
    expect(output[1]?.offsetMs).toBe(3_600_000);
  });
});
describe('transcript rendering', () => {
  it('parses structured timestamps, normalizes text, and clamps model overshoot', () => {
    expect(
      parseWhisper(
        { transcription: [{ offsets: { from: 0, to: 1500 }, text: ' Hello\nworld ' }] },
        1000,
      ),
    ).toEqual([{ startMs: 0, endMs: 1000, text: 'Hello world' }]);
    expect(() => parseWhisper({ transcription: [{ text: 'invalid' }] }, 1000)).toThrow();
  });
  it('sorts by capture time, preserves overlaps, and disambiguates duplicate aliases', () => {
    const result = renderTranscript(
      session(),
      [
        { userId: 'a', displayName: 'Alice', transcriptName: 'Name' },
        { userId: 'b', displayName: 'Bob', transcriptName: 'Name' },
      ],
      [
        { userId: 'b', startMs: 200, endMs: 400, text: 'Second' },
        { userId: 'a', startMs: 100, endMs: 500, text: 'First' },
      ],
      1,
    );
    expect(result.indexOf('First')).toBeLessThan(result.indexOf('Second'));
    expect(result).toContain('Name (a): First');
    expect(result).toContain('INCOMPLETE');
    expect(timestamp(3_661_005)).toBe('01:01:01.005');
  });
  it('splits UTF-8 attachments without losing bytes or breaking characters', () => {
    const text = '名前: こんにちは😀\n'.repeat(20);
    const parts = splitTranscript(text, 47);
    expect(parts.every((part) => part.length <= 47 && !part.toString().includes('\ufffd'))).toBe(
      true,
    );
    expect(Buffer.concat(parts).toString()).toBe(text);
  });
});
