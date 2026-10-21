import { afterEach, expect, it, vi } from 'vitest';
import { AIReportGenerator, type StructuredRequest } from '../src/reports/providers.js';
import {
  filledTemplate,
  templateLayout,
  templateFields,
  templateMembers,
  templateText,
  templateAppendRequests,
  validateTemplateDraft,
} from '../src/reports/template.js';
import {
  GoogleReportDocuments,
  reportRangeName,
  type DocsRequest,
} from '../src/reports/google-docs.js';
import { renderReport } from '../src/reports/schema.js';
import type { TemplateParagraph, ReportDraft } from '../src/reports/types.js';
import { reportInput, reportJob, template } from './reports-helpers.js';

afterEach(() => vi.unstubAllEnvs());
const paragraph = (text: string, level?: number): TemplateParagraph => ({
  runs: [{ text, style: { fontSize: { magnitude: 12, unit: 'PT' } } }],
  style: { namedStyleType: 'NORMAL_TEXT' },
  ...(level === undefined ? {} : { nestingLevel: level }),
});
const wireDraft = (draft: ReportDraft) => ({
  fields: draft.sections.map((section) => ({ fieldId: section.heading, entries: section.entries })),
});
function fixture() {
  const paragraphs = [
    paragraph('<Date of meeting/transcript> Meeting\n'),
    paragraph('Last Week (times in hours)\n', 0),
    paragraph('Team Review\n', 1),
    paragraph('<Team summary>\n', 2),
    paragraph('James Ross\n', 1),
    paragraph('<Member details and hours>\n', 2),
    paragraph('Jeremiah Vandagrift\n', 1),
    paragraph('<Member details and hours>\n', 2),
    paragraph('Next week\n', 0),
    paragraph('Team Plan\n', 1),
    paragraph('<Next plans>\n', 2),
    paragraph('James Ross\n', 1),
    paragraph('<Member plans>\n', 2),
    paragraph('Jeremiah Vandagrift\n', 1),
    paragraph('<Member plans>\n', 2),
    paragraph('Blocked\n', 0),
    paragraph('James Ross\n', 1),
    paragraph('<Member blockers>\n', 2),
    paragraph('Jeremiah Vandagrift\n', 1),
    paragraph('<Member blockers>\n', 2),
  ];
  paragraphs[6]!.runs = [
    {
      text: 'Jeremiah Vandagrift',
      style: {},
      person: { name: 'Jeremiah Vandagrift', email: 'test@example.com' },
    },
    { text: '\n', style: {} },
  ];
  const layout = templateLayout(paragraphs);
  const input = {
    ...reportInput,
    speakers: [{ id: 'speaker_1', name: 'Jeremiah V' }],
    meetingStartedAt: Date.parse('2026-10-21T00:12:40.288Z'),
  };
  const draft: ReportDraft = {
    sections: templateFields(layout).map((field) => ({
      heading: field.id,
      entries: [{ kind: 'missing', text: 'Not discussed', speakerIds: [], evidence: [] }],
    })),
  };
  const job = { ...reportJob(), template: { ...template(), layout }, draft };
  return { layout, job, input, draft };
}
it('retains every template section, member and date while adding the exact absence prefix only to missing Last Week members', () => {
  const { job, input, layout } = fixture();
  expect(templateMembers(layout, input)).toEqual([
    { name: 'James Ross', speakerId: null },
    { name: 'Jeremiah Vandagrift', speakerId: 'speaker_1' },
  ]);
  const output = renderReport(job, input);
  expect(output).toContain('October 20, 2026 Meeting\n');
  expect(output).toContain('James Ross\nNot present for meeting.\n');
  expect(output).toContain('Jeremiah Vandagrift\nNot discussed\n');
  expect(output.match(/Not present for meeting\./g)).toHaveLength(1);
  expect(output).not.toContain('<');
  for (const key of [
    'Project:',
    'Source session:',
    'Model:',
    'Channel:',
    'Meeting timezone:',
    'Report format fetched:',
  ])
    expect(output).not.toContain(key);
  expect(filledTemplate(job, input)[6]!.runs[0]!.person?.email).toBe('test@example.com');
});
it('keeps evidence-backed information about an absent member after the absence sentence', () => {
  const { job, input, layout } = fixture();
  const field = layout.slots.find(
    (slot) => slot.member === 'James Ross' && slot.section.startsWith('Last Week'),
  )!;
  job.draft.sections.find((section) => section.heading === field.id)!.entries = [
    {
      kind: 'fact',
      text: 'James might finish Friday if the board arrives.',
      speakerIds: ['speaker_1'],
      evidence: [{ segmentId: 'seg_000001', quote: input.segments[0]!.text }],
    },
  ];
  expect(renderReport(job, input)).toContain(
    'James Ross\nNot present for meeting. James might finish Friday if the board arrives.',
  );
});
it('canonicalizes missing-label punctuation and lets the bot add the absence sentence exactly once', async () => {
  const { job, input, layout } = fixture();
  for (const section of job.draft.sections) {
    const field = layout.slots.find((slot) => slot.id === section.heading)!;
    section.entries[0]!.text =
      field.member === 'James Ross' ? 'Not present for meeting.' : 'Not discussed.';
    section.entries[0]!.speakerIds = ['speaker_1'];
  }
  const client = vi.fn(async ({ operation }: StructuredRequest) => ({
    value: operation === 'verify' ? { issues: [] } : wireDraft(job.draft),
    inputTokens: 1,
    outputTokens: 1,
  }));
  const result = await new AIReportGenerator(() => client).generate(job, input, () => {});
  job.draft = result.draft;
  expect(renderReport(job, input).match(/Not present for meeting\./g)).toHaveLength(1);
  expect(
    result.draft.sections.every((section) =>
      section.entries.every(
        (entry) =>
          entry.kind !== 'missing' ||
          (entry.evidence.length === 0 && entry.speakerIds.length === 0),
      ),
    ),
  ).toBe(true);
});
it('rejects missing, duplicate and invented fields instead of publishing a shortened summary', () => {
  const { layout, draft } = fixture();
  expect(() =>
    validateTemplateDraft({ ...draft, sections: draft.sections.slice(1) }, layout),
  ).toThrow('every template field');
  expect(() =>
    validateTemplateDraft(
      {
        ...draft,
        sections: draft.sections.map((section) => ({
          ...section,
          heading: draft.sections[0]!.heading,
        })),
      },
      layout,
    ),
  ).toThrow('every template field');
});
it('replaces a placeholder split across styled text runs without touching surrounding labels or links', () => {
  const { job, input } = fixture();
  job.template.layout = templateLayout([
    {
      style: { namedStyleType: 'HEADING_2' },
      runs: [
        { text: 'Fixed <Date of ', style: { bold: true } },
        { text: 'meeting/transcript> Meeting\n', style: { italic: true } },
      ],
    },
    paragraph('Last Week\n'),
    paragraph('James Ross\n'),
    {
      style: {},
      runs: [
        { text: 'Prefix <Specific ', style: { bold: true } },
        { text: 'details> suffix\n', style: { italic: true } },
      ],
    },
  ]);
  job.draft = {
    sections: [
      {
        heading: templateFields(job.template.layout)[0]!.id,
        entries: [{ kind: 'missing', text: 'Not discussed', speakerIds: [], evidence: [] }],
      },
    ],
  };
  const rendered = filledTemplate(job, input);
  expect(templateText(rendered)).toContain('Prefix Not present for meeting. suffix');
  expect(rendered[3]!.runs[0]).toMatchObject({ text: 'Prefix ', style: { bold: true } });
  expect(rendered[3]!.runs.at(-1)).toMatchObject({ text: ' suffix\n', style: { italic: true } });
});
it('sends only field instructions, names and spoken text to every generation, repair and review request', async () => {
  const { job, input, layout } = fixture();
  const poisoned = {
    ...input,
    sessionId: 'PRIVATE_SESSION',
    channelName: 'PRIVATE_CHANNEL',
    warnings: ['PRIVATE_WARNING'],
    model: 'medium.en',
    language: 'PRIVATE_LANGUAGE',
    stopped: 'PRIVATE_STOP_REASON',
    discordId: 'PRIVATE_DISCORD_ID',
  };
  let drafts = 0,
    audits = 0;
  const client = vi.fn(async (request: StructuredRequest) => {
    if (request.operation === 'verify')
      return {
        value: { issues: ++audits === 1 ? ['Fix a field.'] : [] },
        inputTokens: 1,
        outputTokens: 1,
      };
    if (++drafts === 1) return { value: { sections: [] }, inputTokens: 1, outputTokens: 1 };
    return { value: wireDraft(job.draft), inputTokens: 1, outputTokens: 1 };
  });
  const result = await new AIReportGenerator(() => client).generate(job, poisoned, () => {});
  expect(result.issues).toEqual([]);
  expect(client.mock.calls.map(([r]) => r.operation)).toEqual([
    'draft',
    'repair',
    'verify',
    'repair_review',
    'verify',
  ]);
  for (const [request] of client.mock.calls) {
    const payload = JSON.stringify(request.payload);
    for (const excluded of [
      'PRIVATE_',
      'medium.en',
      'startMs',
      'endMs',
      'startedAt',
      'timezone',
      '"project":',
      'test@example.com',
      'meetingStartedAt',
    ])
      expect(payload).not.toContain(excluded);
    expect(request.payload).toMatchObject({
      template: { fields: templateFields(layout) },
      speakers: input.speakers,
    });
  }
});
it('reconstructs native bullets, linked person names and styles at valid UTF-16 ranges without changing earlier log content', () => {
  const { job, input } = fixture();
  const paragraphs = filledTemplate(job, input);
  const prefix = 'Existing 😀 log\n';
  const requests = templateAppendRequests(paragraphs, prefix.length, 'tab', reportRangeName(job));
  let document = prefix;
  const links: unknown[] = [];
  for (const request of requests) {
    for (const value of Object.values(request))
      if (value && typeof value === 'object' && 'range' in value) {
        const range = (value as { range: { startIndex: number; endIndex: number; tabId: string } })
          .range;
        expect(range.startIndex).toBeGreaterThanOrEqual(prefix.length);
        expect(range.endIndex).toBeLessThanOrEqual(document.length);
        expect(range.tabId).toBe('tab');
      }
    if ('insertText' in request) {
      const r = request.insertText as { location: { index: number }; text: string };
      document = document.slice(0, r.location.index) + r.text + document.slice(r.location.index);
    }
    if ('createParagraphBullets' in request) {
      const r = request.createParagraphBullets as {
        range: { startIndex: number; endIndex: number };
      };
      const { startIndex: s, endIndex: e } = r.range;
      const selected = document.slice(s, e);
      document = document.slice(0, s) + selected.replace(/^\t+/gm, '') + document.slice(e);
    }
    if ('deleteContentRange' in request) {
      const { startIndex: s, endIndex: e } = (
        request.deleteContentRange as { range: { startIndex: number; endIndex: number } }
      ).range;
      expect(document.slice(s, e)).toBe('@');
      document = document.slice(0, s) + document.slice(e);
    }
    if ('updateTextStyle' in request)
      links.push((request.updateTextStyle as { textStyle: unknown }).textStyle);
  }
  expect(document.startsWith(prefix)).toBe(true);
  expect(document).not.toContain('\t');
  expect(document).not.toContain('Meeting report ID');
  expect(links).toContainEqual({ link: { url: 'mailto:test@example.com' } });
  expect(document).toContain('Jeremiah Vandagrift');
  expect(JSON.stringify(requests)).not.toContain('insertPerson');
  expect(requests.at(-1)).toMatchObject({ createNamedRange: { name: reportRangeName(job) } });
});
it('reconciles native appends using an invisible named range after a lost response', async () => {
  const { job, input } = fixture();
  job.filledTemplate = filledTemplate(job, input);
  job.rendered = renderReport(job, input);
  let writes = 0;
  let published = false;
  const request: DocsRequest = async (_id, method) => {
    if (method === 'POST') {
      writes++;
      published = true;
      throw new Error('Lost response');
    }
    return {
      revisionId: 'revision',
      tabs: [
        {
          tabProperties: { tabId: 'log' },
          documentTab: {
            body: {
              content: [{ endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }],
            },
            namedRanges: published ? { [reportRangeName(job)]: {} } : {},
          },
        },
      ],
    };
  };
  const docs = new GoogleReportDocuments(request);
  await expect(docs.append(job)).rejects.toThrow('Lost response');
  await expect(docs.append(job)).resolves.toContain('?tab=log');
  expect(writes).toBe(1);
});
