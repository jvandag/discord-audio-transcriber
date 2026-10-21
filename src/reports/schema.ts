import { z } from 'zod';
import { ReportError, type ReportDraft, type ReportInput, type ReportJob } from './types.js';
import { filledTemplate, templateText } from './template.js';

export const draftSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1).max(200),
            entries: z
              .array(
                z
                  .object({
                    kind: z.enum(['fact', 'missing']),
                    text: z.string().min(1).max(4000),
                    speakerIds: z.array(z.string()).max(100),
                    evidence: z
                      .array(
                        z.object({ segmentId: z.string(), quote: z.string().min(1).max(4000) }),
                      )
                      .max(40),
                  })
                  .strict(),
              )
              .min(1)
              .max(150),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export const reviewSchema = z
  .object({ issues: z.array(z.string().min(1).max(1000)).max(100) })
  .strict();
export const draftJsonSchema = z.toJSONSchema(draftSchema);
export const reviewJsonSchema = z.toJSONSchema(reviewSchema);
export function groundDraftEvidence(value: unknown, input: ReportInput): unknown {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) return value;
  const sources = new Map(input.segments.map((segment) => [segment.id, segment.text]));
  for (const section of parsed.data.sections) {
    for (const entry of section.entries) {
      if (entry.kind !== 'fact') continue;
      for (const evidence of entry.evidence) {
        const source = sources.get(evidence.segmentId);
        // A valid citation identifies original source text. If the model alters
        // the quotation, use the complete source segment as audit evidence.
        // Never fuzzy-match IDs, truncate source text, or invent an excerpt.
        // The independent audit must still check that it supports the claim.
        if (source && !source.includes(evidence.quote) && source.length <= 4000)
          evidence.quote = source;
      }
    }
  }
  return parsed.data;
}
export function validateDraft(value: unknown, input: ReportInput): ReportDraft {
  const result = draftSchema.safeParse(value);
  if (!result.success)
    throw new ReportError('The AI returned an invalid report structure. Nothing was appended.');
  const segments = new Map(input.segments.map((segment) => [segment.id, segment]));
  const speakers = new Set(input.speakers.map((speaker) => speaker.id));
  for (const section of result.data.sections) {
    if (/[\n\r—]/.test(section.heading))
      throw new ReportError('The AI returned an invalid report heading.');
    for (const entry of section.entries) {
      if (/[\n\r—“”"]/.test(entry.text))
        throw new ReportError(
          'Report prose must use paraphrases, single paragraphs, and no em dashes.',
        );
      if (entry.kind === 'missing') {
        if (
          !['Not discussed', 'Not specified'].includes(entry.text) ||
          entry.evidence.length ||
          entry.speakerIds.length
        )
          throw new ReportError(
            'An unsupported missing-field entry was returned. Use text exactly Not discussed or Not specified, with empty speakerIds and evidence arrays. Put supported facts in kind=fact entries.',
          );
        continue;
      }
      if (!entry.evidence.length)
        throw new ReportError('A report claim has no supporting transcript evidence.');
      const evidenceSpeakers = new Set<string>();
      for (const evidence of entry.evidence) {
        const source = segments.get(evidence.segmentId);
        if (!source || !source.text.includes(evidence.quote))
          throw new ReportError('Report evidence does not match the frozen transcript.');
        evidenceSpeakers.add(source.speakerId);
      }
      for (const id of entry.speakerIds) {
        if (!speakers.has(id) || !evidenceSpeakers.has(id))
          throw new ReportError('A speaker attribution is not supported by the cited segments.');
      }
    }
  }
  return result.data;
}
export function renderReport(job: ReportJob, input: ReportInput): string {
  if (!job.draft) throw new ReportError('No report draft exists.');
  if (job.template?.layout) return templateText(filledTemplate(job, input));
  const date = new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: job.options.timezone,
  }).format(input.meetingStartedAt);
  return [
    `Weekly progress report | ${date}`,
    '',
    ...job.draft.sections.flatMap((section) => [
      section.heading,
      ...section.entries.map((entry) => entry.text),
      '',
    ]),
  ].join('\n');
}
