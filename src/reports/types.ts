import type { ReportsConfig, ReportDestination } from './config.js';
export interface ReportInput {
  sessionId: string;
  meetingStartedAt: number;
  channelName: string;
  speakers: { id: string; name: string }[];
  segments: { id: string; speakerId: string; startMs: number; endMs: number; text: string }[];
  warnings: string[];
}
export interface TemplateSnapshot {
  documentId: string;
  tabId: string;
  revisionId: string;
  title: string;
  text: string;
  fetchedAt: number;
  layout?: TemplateLayout;
}
export interface TemplateRun {
  text: string;
  style: Record<string, unknown>;
  person?: { name: string; email: string };
}
export interface TemplateParagraph {
  runs: TemplateRun[];
  style: Record<string, unknown>;
  nestingLevel?: number;
  bulletPreset?: string;
}
export interface TemplateSlot {
  id: string;
  paragraph: number;
  start: number;
  end: number;
  instruction: string;
  section: string;
  label: string;
  member?: string;
  date: boolean;
}
export interface TemplateLayout {
  paragraphs: TemplateParagraph[];
  slots: TemplateSlot[];
}
export interface ReportEntry {
  kind: 'fact' | 'missing';
  text: string;
  speakerIds: string[];
  evidence: { segmentId: string; quote: string }[];
}
export interface ReportDraft {
  sections: { heading: string; entries: ReportEntry[] }[];
}
export type ReportState =
  | 'queued'
  | 'generating'
  | 'needs_review'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'discarded';
export interface ReportJob {
  id: string;
  sessionId: string;
  guildId: string;
  channelId: string;
  requestedBy: string;
  createdAt: number;
  updatedAt: number;
  state: ReportState;
  attempts: number;
  nextAttemptAt: number;
  options: ReportsConfig;
  destination: ReportDestination;
  inputHash: string;
  template?: TemplateSnapshot;
  guidelines?: string;
  draft?: ReportDraft;
  rendered?: string;
  filledTemplate?: TemplateParagraph[];
  reviewIssues: string[];
  approvedBy?: string;
  error?: string;
  documentUrl?: string;
  publishedAt?: number;
  notificationPending: boolean;
  notificationMessageId?: string;
  usage: { operation: string; inputTokens: number; outputTokens: number }[];
}
export interface ReportDocuments {
  readTemplate(destination: ReportDestination): Promise<TemplateSnapshot>;
  append(job: ReportJob): Promise<string>;
}
export interface ReportGenerator {
  generate(
    job: ReportJob,
    input: ReportInput,
    save: () => void,
  ): Promise<{ draft: ReportDraft; issues: string[] }>;
}
export interface ReportNotifier {
  update(job: ReportJob): Promise<void>;
}
export class ReportError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
