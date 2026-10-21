import { afterEach, expect, it, vi } from 'vitest';
import {
  AIReportGenerator,
  geminiResponseSchema,
  providerClient,
  splitSegments,
  type StructuredRequest,
} from '../src/reports/providers.js';
import {
  draftJsonSchema,
  groundDraftEvidence,
  reviewJsonSchema,
  reviewSchema,
  validateDraft,
} from '../src/reports/schema.js';
import { reportDraft, reportInput, reportJob } from './reports-helpers.js';
const promptSegments = reportInput.segments.map(({ id, speakerId, text }) => ({
  id,
  speakerId,
  text,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('avoids Gemini decoding-state explosions while retaining local report limits', () => {
  const original = JSON.stringify(draftJsonSchema);
  const adapted = JSON.stringify(geminiResponseSchema(draftJsonSchema));
  expect(adapted).not.toContain('"maxItems":');
  expect(adapted).toContain('At most 150 items.');
  expect(adapted).toContain('"required":');
  expect(adapted).toContain('"enum":["fact","missing"]');
  expect(JSON.stringify(draftJsonSchema)).toBe(original);
  expect(JSON.stringify(geminiResponseSchema(reviewJsonSchema))).not.toContain('"maxItems":');
  expect(reviewSchema.safeParse({ issues: Array(101).fill('Issue') }).success).toBe(false);
  const tooManySections = { sections: Array(41).fill(reportDraft.sections[0]) };
  expect(() => validateDraft(tooManySections, reportInput)).toThrow('invalid report structure');
});

it('validates exact evidence, speaker links, missing fields, and prose restrictions', () => {
  expect(validateDraft(reportDraft, reportInput)).toEqual(reportDraft);
  const badQuote = structuredClone(reportDraft);
  badQuote.sections[0]!.entries[0]!.evidence[0]!.quote = 'I will definitely finish Friday.';
  expect(() => validateDraft(badQuote, reportInput)).toThrow('does not match');
  const badSpeaker = structuredClone(reportDraft);
  badSpeaker.sections[0]!.entries[0]!.speakerIds = ['speaker_2'];
  expect(() => validateDraft(badSpeaker, reportInput)).toThrow('attribution');
  const unsupported = structuredClone(reportDraft);
  unsupported.sections[0]!.entries[0]!.evidence = [];
  expect(() => validateDraft(unsupported, reportInput)).toThrow('no supporting');
  const badMissing = structuredClone(reportDraft);
  badMissing.sections[0]!.entries[0]!.kind = 'missing';
  expect(() => validateDraft(badMissing, reportInput)).toThrow('unsupported');
  const prose = structuredClone(reportDraft);
  prose.sections[0]!.entries[0]!.text = 'Alex said “I will finish Friday.”';
  expect(() => validateDraft(prose, reportInput)).toThrow('paraphrases');
});
it('uses the complete original segment when a known citation has an altered quote', () => {
  const candidate = structuredClone(reportDraft);
  candidate.sections[0]!.entries[0]!.evidence[0]!.quote = 'An altered quote.';
  const grounded = validateDraft(groundDraftEvidence(candidate, reportInput), reportInput);
  expect(grounded.sections[0]!.entries[0]!.evidence[0]!.quote).toBe(reportInput.segments[0]!.text);
  expect(candidate.sections[0]!.entries[0]!.evidence[0]!.quote).toBe('An altered quote.');
  candidate.sections[0]!.entries[0]!.evidence[0]!.segmentId = 'unknown';
  expect(() => validateDraft(groundDraftEvidence(candidate, reportInput), reportInput)).toThrow(
    'does not match',
  );
});
it('uses the fetched template and independently checks meaning without tools', async () => {
  const job = reportJob();
  const client = vi.fn(async (request: StructuredRequest) => ({
    value:
      request.operation === 'verify' ? { issues: ['The source is conditional.'] } : reportDraft,
    inputTokens: 100,
    outputTokens: 50,
  }));
  const save = vi.fn();
  const result = await new AIReportGenerator(() => client).generate(job, reportInput, save);
  expect(result.issues).toEqual(['The source is conditional.']);
  expect(client.mock.calls[0]?.[0].payload).toMatchObject({
    template: job.template!.text,
    segments: promptSegments,
  });
  expect(client.mock.calls[1]?.[0].payload).toMatchObject({
    draft: reportDraft,
    segments: promptSegments,
  });
  expect(client.mock.calls[0]?.[0].system).toContain('untrusted data');
  expect(client.mock.calls[1]?.[0].system).toContain('Audit only payload.draft');
  expect(client.mock.calls[1]?.[0].system).toContain('Do not audit the template itself');
  expect(client.mock.calls[1]?.[0].system).not.toBe(client.mock.calls[0]?.[0].system);
  expect(job.usage).toHaveLength(4);
  expect(save).toHaveBeenCalledTimes(4);
  expect(client.mock.calls.map(([request]) => request.operation)).toEqual([
    'draft',
    'verify',
    'repair_review',
    'verify',
  ]);
});
it('requires a fresh clean audit after correcting a flagged claim', async () => {
  let audits = 0;
  const client = vi.fn(async ({ operation }: StructuredRequest) => ({
    value:
      operation === 'verify'
        ? { issues: ++audits === 1 ? ['Preserve the tentative wording.'] : [] }
        : reportDraft,
    inputTokens: 1,
    outputTokens: 1,
  }));
  const result = await new AIReportGenerator(() => client).generate(
    reportJob(),
    reportInput,
    () => {},
  );
  expect(result.issues).toEqual([]);
  expect(client.mock.calls.map(([request]) => request.operation)).toEqual([
    'draft',
    'verify',
    'repair_review',
    'verify',
  ]);
  expect(client.mock.calls[2]?.[0].payload).toMatchObject({
    issues: ['Preserve the tentative wording.'],
    segments: promptSegments,
  });
});
it('repairs invalid evidence once, then validates and independently reviews the corrected draft', async () => {
  const invalid = structuredClone(reportDraft);
  invalid.sections[0]!.entries[0]!.evidence[0]!.segmentId = 'unknown-segment';
  const client = vi.fn(async ({ operation }: StructuredRequest) => ({
    value: operation === 'draft' ? invalid : operation === 'verify' ? { issues: [] } : reportDraft,
    inputTokens: 1,
    outputTokens: 1,
  }));
  const result = await new AIReportGenerator(() => client).generate(
    reportJob(),
    reportInput,
    () => {},
  );
  expect(client.mock.calls.map(([request]) => request.operation)).toEqual([
    'draft',
    'repair',
    'verify',
  ]);
  expect(client.mock.calls[1]?.[0].payload).toMatchObject({
    candidate: invalid,
    segments: promptSegments,
    validationError: expect.stringContaining('does not match'),
  });
  expect(result).toEqual({ draft: reportDraft, issues: [] });
});
it('rejects an unsuccessful repair without relaxing evidence checks or looping', async () => {
  const invalid = structuredClone(reportDraft);
  invalid.sections[0]!.entries[0]!.evidence[0]!.segmentId = 'unknown-segment';
  const client = vi.fn(async (_request: StructuredRequest) => ({
    value: invalid,
    inputTokens: 1,
    outputTokens: 1,
  }));
  await expect(
    new AIReportGenerator(() => client).generate(reportJob(), reportInput, () => {}),
  ).rejects.toThrow('does not match');
  expect(client.mock.calls.map(([request]) => request.operation)).toEqual(['draft', 'repair']);
});
it('never drops segments when splitting large transcripts', () => {
  const input = {
    ...reportInput,
    segments: Array.from({ length: 50 }, (_, i) => ({
      ...reportInput.segments[0]!,
      id: `seg_${i}`,
      text: 'Conditional progress update. '.repeat(10),
    })),
  };
  const chunks = splitSegments(input, 2000);
  expect(new Set(chunks.flat().map((segment) => segment.id))).toEqual(
    new Set(input.segments.map((segment) => segment.id)),
  );
  expect(chunks.length).toBeGreaterThan(1);
  expect(() => splitSegments(input, 10)).toThrow('Nothing was truncated');
});
it('extracts all long-transcript chunks before consolidation and review', async () => {
  const input = {
    ...reportInput,
    segments: Array.from({ length: 28 }, (_, i) => ({
      ...reportInput.segments[0]!,
      id: `seg_${i}`,
      text: 'Conditional progress update. '.repeat(9),
    })),
  };
  const job = reportJob();
  job.options.maxInputCharacters = 10000;
  job.options.chunkCharacters = 2000;
  const seen = new Set<string>();
  const client = vi.fn(async ({ operation, payload }: StructuredRequest) => {
    const data = payload as { segments?: typeof input.segments };
    if (operation.startsWith('extract')) {
      data.segments!.forEach((segment) => seen.add(segment.id));
      const segment = data.segments![0]!;
      return {
        value: {
          sections: [
            {
              heading: 'Progress',
              entries: [
                {
                  kind: 'fact',
                  text: 'A conditional update was discussed.',
                  speakerIds: ['speaker_1'],
                  evidence: [{ segmentId: segment.id, quote: 'Conditional progress update.' }],
                },
              ],
            },
          ],
        },
        inputTokens: 1,
        outputTokens: 1,
      };
    }
    return {
      value:
        operation === 'verify'
          ? { issues: [] }
          : {
              sections: [
                {
                  heading: 'Progress',
                  entries: [
                    {
                      kind: 'fact',
                      text: 'A conditional update was discussed.',
                      speakerIds: ['speaker_1'],
                      evidence: [{ segmentId: 'seg_0', quote: 'Conditional progress update.' }],
                    },
                  ],
                },
              ],
            },
      inputTokens: 1,
      outputTokens: 1,
    };
  });
  await new AIReportGenerator(() => client).generate(job, input, () => {});
  expect(seen.size).toBe(28);
  expect(client.mock.calls.some(([request]) => request.operation === 'consolidate')).toBe(true);
  expect(client.mock.calls.at(-1)?.[0].operation).toBe('verify');
});
it.each(['openai', 'gemini'] as const)(
  'maps structured requests and responses through the %s SDK',
  async (provider) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            provider === 'openai'
              ? {
                  id: 'resp_test',
                  object: 'response',
                  status: 'completed',
                  output: [
                    {
                      type: 'message',
                      role: 'assistant',
                      content: [
                        { type: 'output_text', text: JSON.stringify(reportDraft), annotations: [] },
                      ],
                    },
                  ],
                  usage: { input_tokens: 20, output_tokens: 10 },
                }
              : {
                  candidates: [
                    {
                      finishReason: 'STOP',
                      content: { parts: [{ text: JSON.stringify(reportDraft) }] },
                    },
                  ],
                  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
                },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const options = reportJob().options;
    options.provider = provider;
    const result = await providerClient(options)({
      operation: 'draft',
      system: 'Keep facts.',
      payload: { transcript: 'test' },
      schema: draftJsonSchema,
    });
    expect(result).toEqual({ value: reportDraft, inputTokens: 20, outputTokens: 10 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(requestBody.includes('"maxItems":')).toBe(provider === 'openai');
  },
);

it.each([
  [400, 'INVALID_ARGUMENT', 'JSON schema'],
  [400, 'FAILED_PRECONDITION', 'billing requirements'],
  [429, 'RESOURCE_EXHAUSTED', 'quota or rate limit'],
  [503, 'UNAVAILABLE', 'high demand'],
] as const)(
  'explains Gemini %s / %s without exposing private error contents',
  async (code, status, hint) => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code, status, message: 'private-transcript-and-secret' },
            }),
            { status: code, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const error = await providerClient(reportJob().options)({
      operation: 'draft',
      system: 'test',
      payload: {},
      schema: draftJsonSchema,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(hint);
    expect(String(error)).toContain('during draft');
    expect(String(error)).not.toContain('private-transcript-and-secret');
  },
);
it('rejects missing keys without making an external request', async () => {
  vi.stubEnv('GEMINI_API_KEY', '');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    providerClient(reportJob().options)({
      operation: 'draft',
      system: '',
      payload: {},
      schema: draftJsonSchema,
    }),
  ).rejects.toThrow('GEMINI_API_KEY');
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['openai', 'gemini'] as const)(
  'does not retry %s requests inside the SDK',
  async (provider) => {
    vi.stubEnv('OPENAI_API_KEY', 'test');
    vi.stubEnv('GEMINI_API_KEY', 'test');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const options = reportJob().options;
    options.provider = provider;
    await expect(
      providerClient(options)({
        operation: 'draft',
        system: 'test',
        payload: {},
        schema: draftJsonSchema,
      }),
    ).rejects.toThrow('report request failed');
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
