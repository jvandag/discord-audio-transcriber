import type { Participant, Segment, Session } from '../shared/types.js';

export function timestamp(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor(value / 60_000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
}
export function renderTranscript(
  session: Session,
  participants: Participant[],
  segments: Segment[],
  failed: number,
): string {
  const names = new Map(
    participants.map((person) => [person.userId, person.transcriptName ?? person.displayName]),
  );
  const duplicateNames = new Set(
    [...names.values()].filter((name, i, all) => all.indexOf(name) !== i),
  );
  const lines = [
    `Session started: ${new Date(session.startedAt).toISOString()}`,
    `Voice channel: ${session.channelName}`,
    `Model: ${session.model}`,
    `Language: ${session.language === 'auto' ? 'auto-detect per chunk' : session.language}`,
    'Timestamps: approximate elapsed time since capture started',
    `Stopped: ${session.reason ?? 'requested'}`,
    ...(session.warnings ?? []).map((warning) => `WARNING: ${warning}`),
    ...(failed ? [`INCOMPLETE: ${failed} audio chunk(s) could not be transcribed.`] : []),
    '',
    'Participants:',
    ...participants.map((person) => `- ${names.get(person.userId)} (Discord ID: ${person.userId})`),
    '',
  ];
  for (const segment of [...segments].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.userId.localeCompare(b.userId),
  )) {
    const name = names.get(segment.userId) ?? segment.userId;
    const label = duplicateNames.has(name) ? `${name} (${segment.userId})` : name;
    lines.push(
      `[${timestamp(segment.startMs)}–${timestamp(segment.endMs)}] ${label}: ${segment.text}`,
    );
  }
  if (!segments.length) lines.push('(No speech was transcribed.)');
  return lines.join('\n') + '\n';
}
/** Split at lines and UTF-8 character boundaries, never in the middle of a multibyte codepoint. */
export function splitTranscript(text: string, maxBytes: number): Buffer[] {
  if (maxBytes < 4) throw new Error('Attachment limit is too small.');
  const files: Buffer[] = [];
  let current = '';
  let bytes = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (Buffer.byteLength(line) <= maxBytes) {
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        files.push(Buffer.from(current));
        current = '';
        bytes = 0;
      }
      current += line;
      bytes += Buffer.byteLength(line);
    } else {
      for (const char of line) {
        const size = Buffer.byteLength(char);
        if (bytes + size > maxBytes) {
          files.push(Buffer.from(current));
          current = '';
          bytes = 0;
        }
        current += char;
        bytes += size;
      }
    }
  }
  if (current) files.push(Buffer.from(current));
  return files;
}
