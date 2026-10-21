import type { Session } from '../shared/types.js';
import type { Store } from '../storage/store.js';
import type { ReportInput } from './types.js';

export function snapshotReportInput(store: Store, session: Session): ReportInput {
  const existing = store.reportInput(session.id);
  if (existing) return existing;
  const people = store.participants(session.id);
  const ids = new Map(people.map((person, i) => [person.userId, `speaker_${i + 1}`]));
  const names = people.map((person) => person.transcriptName ?? person.displayName);
  const input: ReportInput = {
    sessionId: session.id,
    meetingStartedAt: session.startedAt,
    channelName: session.channelName,
    speakers: people.map((person, i) => ({
      id: ids.get(person.userId)!,
      name:
        names.filter((name) => name === names[i]).length > 1
          ? `${names[i]} (${ids.get(person.userId)})`
          : names[i]!,
    })),
    segments: store.segments(session.id).map((segment, i) => ({
      id: `seg_${String(i + 1).padStart(6, '0')}`,
      speakerId: ids.get(segment.userId) ?? 'unknown',
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
    warnings: [
      ...(session.warnings ?? []),
      ...(store.counts(session.id).failed
        ? [`${store.counts(session.id).failed} audio chunks could not be transcribed.`]
        : []),
      ...(/interrupt|lost|missing|removed|moved|failed/i.test(session.reason ?? '')
        ? [session.reason!]
        : []),
    ],
  };
  store.saveReportInput(input);
  return input;
}
