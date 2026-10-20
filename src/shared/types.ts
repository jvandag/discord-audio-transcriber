export type SessionState = 'connecting' | 'recording' | 'finalizing' | 'completed' | 'interrupted';
export interface Settings {
  model: string;
  language: string;
}
export interface Session extends Settings {
  id: string;
  guildId: string;
  channelId: string;
  channelName: string;
  messageId: string | null;
  startedAt: number;
  endedAt: number | null;
  state: SessionState;
  reason: string | null;
  delivered: boolean;
  warnings?: string[];
}
export interface Participant {
  userId: string;
  displayName: string;
  transcriptName: string | null;
}
export interface Member {
  userId: string;
  displayName: string;
  username: string;
}
export interface AudioChunk {
  id: string;
  sessionId: string;
  userId: string;
  offsetMs: number;
  durationMs: number;
  path: string;
  bytes: number;
}
export interface Job extends AudioChunk {
  attempts: number;
}
export interface Segment {
  userId: string;
  startMs: number;
  endMs: number;
  text: string;
}
export interface SpeechSegment {
  startMs: number;
  endMs: number;
  text: string;
}
export interface JobCounts {
  pending: number;
  done: number;
  failed: number;
}
