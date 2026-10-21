import { expect, it, vi } from 'vitest';
import {
  contentText,
  documentBodies,
  GoogleReportDocuments,
  reportMarker,
  type DocsRequest,
} from '../src/reports/google-docs.js';
import { documentTarget, configuredDestination } from '../src/reports/config.js';
import { reportJob, reportOptions } from './reports-helpers.js';
function document(text = 'Existing log\n', revisionId = 'revision-1') {
  return {
    title: 'Weekly log',
    revisionId,
    tabs: [
      {
        tabProperties: { tabId: 't1', title: 'Log' },
        documentTab: {
          body: {
            content: [
              {
                endIndex: text.length + 1,
                paragraph: { elements: [{ textRun: { content: text } }] },
              },
            ],
          },
        },
      },
    ],
  };
}
it('reads the template afresh, retains tables, and never writes the template', async () => {
  const request = vi
    .fn<DocsRequest>()
    .mockResolvedValueOnce(document('Old format\n'))
    .mockResolvedValueOnce(document('New format\n'));
  const docs = new GoogleReportDocuments(request);
  expect((await docs.readTemplate(reportJob().destination)).text).toBe('Old format');
  expect((await docs.readTemplate(reportJob().destination)).text).toBe('New format');
  expect(request.mock.calls.every(([id, method]) => id === 'template' && method === 'GET')).toBe(
    true,
  );
  expect(
    contentText([
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Owner\n' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Action\n' } }] } }] },
              ],
            },
          ],
        },
      },
    ]),
  ).toBe('Owner | Action\n');
});
it('requires explicit selection for multiple tabs, including nested tabs', async () => {
  const doc = document();
  doc.tabs[0] = { ...doc.tabs[0]!, ...{ childTabs: document().tabs } };
  expect(documentBodies(doc)).toHaveLength(2);
  const docs = new GoogleReportDocuments(vi.fn<DocsRequest>().mockResolvedValue(doc));
  await expect(docs.readTemplate(reportJob().destination)).rejects.toThrow('multiple tabs');
  const selected = await docs.readTemplate({ ...reportJob().destination, templateTabId: 't1' });
  expect(selected.tabId).toBe('t1');
});
it('appends only new content with revision control, UTF-16 indexes, and scoped styles', async () => {
  const original = 'Existing 😀 log\n';
  const request = vi.fn<DocsRequest>().mockResolvedValue(document(original));
  const job = reportJob();
  const url = await new GoogleReportDocuments(request).append(job);
  expect(url).toContain('?tab=t1');
  const [id, method, payload] = request.mock.calls[1]!;
  expect(id).toBe('log');
  expect(method).toBe('POST');
  expect(payload).toMatchObject({
    writeControl: { requiredRevisionId: 'revision-1' },
    requests: [
      {
        insertText: {
          location: { index: original.length, tabId: 't1' },
          text: expect.stringContaining(reportMarker(job)),
        },
      },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    ],
  });
  expect(JSON.stringify(payload)).not.toContain('deleteContentRange');
});
it('reconciles a lost append response before retrying, avoiding a second write', async () => {
  const job = reportJob();
  let text = 'Existing log\n';
  let writes = 0;
  const request: DocsRequest = async (_id, method, body) => {
    if (method === 'POST') {
      writes++;
      text += (body as { requests: { insertText?: { text: string } }[] }).requests[0]!.insertText!
        .text;
      throw new Error('Connection lost after successful append');
    }
    return document(text);
  };
  const docs = new GoogleReportDocuments(request);
  await expect(docs.append(job)).rejects.toThrow('Connection lost');
  await expect(docs.append(job)).resolves.toContain('/log/edit');
  expect(writes).toBe(1);
});
it('fails on empty templates and logs without edit revisions', async () => {
  const docs = new GoogleReportDocuments(vi.fn<DocsRequest>().mockResolvedValue(document('', '')));
  await expect(docs.readTemplate(reportJob().destination)).rejects.toThrow('empty');
  await expect(docs.append(reportJob())).rejects.toThrow('editable');
});
it('validates Google URLs, tab parameters, and separate destination documents', () => {
  expect(documentTarget('https://docs.google.com/document/d/test/edit?tab=abc')).toEqual({
    documentId: 'test',
    tabId: 'abc',
  });
  expect(
    documentTarget('https://docs.google.com/document/d/test/edit?tab=abc', 'explicit').tabId,
  ).toBe('explicit');
  expect(() => documentTarget('https://attacker.example/document/d/test')).toThrow('Google Docs');
  const options = reportOptions();
  vi.stubEnv('TEST_REPORT_LOG_URL', process.env.TEST_REPORT_TEMPLATE_URL!);
  expect(() => configuredDestination(options, 'guild-1')).toThrow('different');
});
