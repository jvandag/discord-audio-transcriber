import type { Session } from '../src/shared/types.js';
export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    guildId: 'guild-1',
    channelId: 'voice-1',
    channelName: 'General',
    messageId: null,
    startedAt: 0,
    endedAt: null,
    state: 'recording',
    reason: null,
    delivered: false,
    model: 'base.en',
    language: 'en',
    ...overrides,
  };
}
