import { parseConfig } from '../src/config/index.js';
import { vi } from 'vitest';
import { configuredDestination } from '../src/reports/config.js';
import { Store } from '../src/storage/store.js';
import { session } from './helpers.js';
import type {
  ReportDraft,
  ReportInput,
  ReportJob,
  TemplateSnapshot,
} from '../src/reports/types.js';
export function reportOptions() {
  vi.stubEnv('TEST_REPORT_TEMPLATE_URL', 'https://docs.google.com/document/d/template/edit');
  vi.stubEnv('TEST_REPORT_LOG_URL', 'https://docs.google.com/document/d/log/edit');
  return parseConfig({
    reports: {
      enabled: true,
      model: 'test-model',
      guilds: {
        'guild-1': {
          templateUrlEnv: 'TEST_REPORT_TEMPLATE_URL',
          logUrlEnv: 'TEST_REPORT_LOG_URL',
          project: 'Test project',
        },
      },
    },
  }).reports;
}
export const reportInput: ReportInput = {
  sessionId: 'session-1',
  meetingStartedAt: 0,
  channelName: 'General',
  speakers: [{ id: 'speaker_1', name: 'Alex' }],
  segments: [
    {
      id: 'seg_000001',
      speakerId: 'speaker_1',
      startMs: 0,
      endMs: 1000,
      text: 'I might finish Friday if the board arrives.',
    },
  ],
  warnings: [],
};
export const reportDraft: ReportDraft = {
  sections: [
    {
      heading: 'Next steps',
      entries: [
        {
          kind: 'fact',
          text: 'Alex might finish Friday if the board arrives.',
          speakerIds: ['speaker_1'],
          evidence: [
            { segmentId: 'seg_000001', quote: 'I might finish Friday if the board arrives.' },
          ],
        },
      ],
    },
  ],
};
export function template(
  text = 'Next steps: summarize conditional plans accurately.',
): TemplateSnapshot {
  return {
    documentId: 'template',
    tabId: 'tab',
    revisionId: 'r1',
    title: 'Live format',
    text,
    fetchedAt: 100,
  };
}
export function reportJob(): ReportJob {
  const options = reportOptions();
  return {
    id: 'report-id',
    sessionId: 'session-1',
    guildId: 'guild-1',
    channelId: 'voice-1',
    requestedBy: 'editor',
    createdAt: 0,
    updatedAt: 0,
    state: 'ready',
    attempts: 0,
    nextAttemptAt: 0,
    options,
    destination: configuredDestination(options, 'guild-1'),
    inputHash: '',
    template: template(),
    guidelines: 'Preserve meaning.',
    draft: structuredClone(reportDraft),
    rendered:
      'Weekly progress report | January 1\nNext steps\nAlex might finish Friday if the board arrives.\n',
    reviewIssues: [],
    notificationPending: true,
    usage: [],
  };
}
export function reportStore() {
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  store.saveSession(session({ state: 'completed', delivered: true, endedAt: 1000 }));
  store.saveReportInput(structuredClone(reportInput));
  return store;
}
