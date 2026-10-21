import { googleAuthFromEnvironment } from './google-auth.js';
import { documentTarget, type ReportDestination } from './config.js';
import { templateLayout, templateAppendRequests } from './template.js';
import {
  ReportError,
  type ReportDocuments,
  type ReportJob,
  type TemplateSnapshot,
  type TemplateParagraph,
} from './types.js';

interface Element {
  endIndex?: number;
  paragraph?: {
    paragraphStyle?: Record<string, unknown>;
    bullet?: { nestingLevel?: number; listId?: string };
    elements?: {
      textRun?: { content?: string; textStyle?: Record<string, unknown> };
      person?: {
        textStyle?: Record<string, unknown>;
        personProperties?: { name?: string; email?: string };
      };
      richLink?: { richLinkProperties?: { title?: string; uri?: string } };
    }[];
  };
  table?: { tableRows?: { tableCells?: { content?: Element[] }[] }[] };
  tableOfContents?: { content?: Element[] };
}
interface Tab {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: {
    body?: { content?: Element[] };
    namedRanges?: Record<string, unknown>;
    namedStyles?: { styles?: NamedStyle[] };
    lists?: Record<
      string,
      { listProperties?: { nestingLevels?: { glyphSymbol?: string; glyphType?: string }[] } }
    >;
  };
  childTabs?: Tab[];
}
interface Document {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: Element[] };
  tabs?: Tab[];
  namedRanges?: Record<string, unknown>;
  namedStyles?: { styles?: NamedStyle[] };
}
interface NamedStyle {
  namedStyleType?: string;
  textStyle?: Record<string, unknown>;
  paragraphStyle?: Record<string, unknown>;
}
export interface DocumentBody {
  tabId: string;
  title: string;
  content: Element[];
  namedRanges?: Record<string, unknown>;
  namedStyles?: { styles?: NamedStyle[] };
}
export function documentBodies(doc: Document): DocumentBody[] {
  const result: DocumentBody[] = [];
  const walk = (tabs: Tab[]) => {
    for (const tab of tabs) {
      if (tab.documentTab)
        result.push({
          tabId: tab.tabProperties?.tabId ?? '',
          title: tab.tabProperties?.title ?? '',
          content: tab.documentTab.body?.content ?? [],
          namedRanges: tab.documentTab.namedRanges,
          namedStyles: tab.documentTab.namedStyles ?? doc.namedStyles,
        });
      walk(tab.childTabs ?? []);
    }
  };
  walk(doc.tabs ?? []);
  if (!result.length && doc.body)
    result.push({
      tabId: '',
      title: doc.title ?? '',
      content: doc.body.content ?? [],
      namedRanges: doc.namedRanges,
      namedStyles: doc.namedStyles,
    });
  return result;
}
export function contentText(elements: Element[]): string {
  return elements
    .map((element) => {
      if (element.paragraph)
        return (element.paragraph.elements ?? [])
          .map(
            (part) =>
              part.textRun?.content ??
              part.person?.personProperties?.name ??
              part.richLink?.richLinkProperties?.title ??
              '',
          )
          .join('');
      if (element.table)
        return (
          (element.table.tableRows ?? [])
            .map((row) =>
              (row.tableCells ?? [])
                .map((cell) => contentText(cell.content ?? []).trim())
                .join(' | '),
            )
            .join('\n') + '\n'
        );
      return contentText(element.tableOfContents?.content ?? []);
    })
    .join('');
}
function selectedBody(doc: Document, tabId?: string) {
  const bodies = documentBodies(doc);
  const body = tabId
    ? bodies.find((tab) => tab.tabId === tabId)
    : bodies.length === 1
      ? bodies[0]
      : undefined;
  if (!body)
    throw new ReportError(
      'Choose an existing Google Docs tab ID; documents with multiple tabs require an explicit tab.',
    );
  return body;
}
export type DocsRequest = (
  documentId: string,
  method: 'GET' | 'POST',
  body?: unknown,
) => Promise<Document>;

export function googleDocsRequest(timeoutSeconds: number): DocsRequest {
  // Initialize lazily so invalid optional report credentials never block recording.
  let auth: ReturnType<typeof googleAuthFromEnvironment> | undefined;
  return async (documentId, method, body) => {
    let token: string | null | undefined;
    try {
      auth ??= googleAuthFromEnvironment();
      token = await auth.getAccessToken();
    } catch (error) {
      if (error instanceof ReportError) throw error;
      throw new ReportError(
        'Google authentication failed. Set GOOGLE_CREDENTIALS_JSON in .env or GOOGLE_APPLICATION_CREDENTIALS to the bot’s credential file.',
      );
    }
    if (!token) throw new ReportError('Google authentication did not return an access token.');
    const suffix = method === 'GET' ? '?includeTabsContent=true' : ':batchUpdate';
    let response: Response;
    try {
      response = await fetch(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}${suffix}`,
        {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        },
      );
    } catch {
      throw new ReportError(
        'Google Docs request timed out or lost its connection. The publication outcome will be checked before retrying.',
        true,
      );
    }
    if (!response.ok)
      throw new ReportError(
        `Google Docs returned HTTP ${response.status}. Check document access, tab IDs, and the Docs API configuration.`,
        response.status === 400 || response.status === 429 || response.status >= 500,
      );
    return (await response.json()) as Document;
  };
}

export function reportMarker(job: Pick<ReportJob, 'id'>) {
  return `[Meeting report ID: ${job.id}]`;
}
export const reportRangeName = (job: Pick<ReportJob, 'id'>) => `meeting-report-${job.id}`;

const textStyleKeys = new Set(
  'bold italic underline strikethrough smallCaps backgroundColor foregroundColor fontSize weightedFontFamily baselineOffset link'.split(
    ' ',
  ),
);
const paragraphStyleKeys = new Set(
  'namedStyleType alignment lineSpacing direction spacingMode spaceAbove spaceBelow borderBetween borderTop borderBottom borderLeft borderRight indentFirstLine indentStart indentEnd keepWithNext keepTogether pageBreakBefore avoidWidowAndOrphan tabStops'.split(
    ' ',
  ),
);
const styleFields = (value: Record<string, unknown> | undefined, allowed: Set<string>) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => allowed.has(key)));

function snapshotParagraphs(body: DocumentBody): TemplateParagraph[] {
  const styles = body.namedStyles?.styles ?? [];
  const normal = styles.find((style) => style.namedStyleType === 'NORMAL_TEXT');
  return body.content.flatMap((element) => {
    if (element.table || element.tableOfContents)
      throw new ReportError(
        'Exact report templates currently support paragraphs, nested bullets, links and person chips. Remove tables or other embedded structures from the template.',
      );
    if (!element.paragraph) return [];
    const paragraph = element.paragraph;
    const named = styles.find(
      (style) =>
        style.namedStyleType === (paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'),
    );
    return [
      {
        style: styleFields(
          { ...normal?.paragraphStyle, ...named?.paragraphStyle, ...paragraph.paragraphStyle },
          paragraphStyleKeys,
        ),
        ...(paragraph.bullet
          ? {
              nestingLevel: paragraph.bullet.nestingLevel ?? 0,
              bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
            }
          : {}),
        runs: (paragraph.elements ?? []).map((part) => {
          if (part.textRun)
            return {
              text: part.textRun.content ?? '',
              style: styleFields(
                { ...normal?.textStyle, ...named?.textStyle, ...part.textRun.textStyle },
                textStyleKeys,
              ),
            };
          const person = part.person?.personProperties;
          if (person?.email)
            return {
              text: person.name ?? person.email,
              person: { name: person.name ?? person.email, email: person.email },
              style: styleFields(
                { ...normal?.textStyle, ...named?.textStyle, ...part.person?.textStyle },
                textStyleKeys,
              ),
            };
          throw new ReportError(
            'The report template contains an unsupported embedded element. Use text, hyperlinks and person chips.',
          );
        }),
      },
    ];
  });
}
export class GoogleReportDocuments implements ReportDocuments {
  constructor(private request: DocsRequest) {}
  async readTemplate(destination: ReportDestination): Promise<TemplateSnapshot> {
    const target = documentTarget(destination.templateUrl, destination.templateTabId);
    const doc = await this.request(target.documentId, 'GET');
    const body = selectedBody(doc, target.tabId);
    const text = contentText(body.content).trim();
    if (!text)
      throw new ReportError(
        'The live report template is empty. Add the format and field guidelines to it.',
      );
    return {
      documentId: target.documentId,
      tabId: body.tabId,
      title: doc.title ?? 'Report template',
      revisionId: doc.revisionId ?? '',
      text,
      fetchedAt: Date.now(),
      ...(/<[^<>\n]+>/.test(text) ? { layout: templateLayout(snapshotParagraphs(body)) } : {}),
    };
  }
  async inspectLog(destination: ReportDestination) {
    const target = documentTarget(destination.logUrl, destination.logTabId);
    const doc = await this.request(target.documentId, 'GET');
    selectedBody(doc, target.tabId);
    if (!doc.revisionId)
      throw new ReportError('The weekly log must be editable by the bot’s Google identity.');
    return doc.title ?? target.documentId;
  }
  async append(job: ReportJob): Promise<string> {
    if (!job.rendered || !job.draft)
      throw new ReportError('There is no validated report to publish.');
    const target = documentTarget(job.destination.logUrl, job.destination.logTabId);
    // Each attempt reads first: a lost response must never trigger a blind second append.
    const doc = await this.request(target.documentId, 'GET');
    const body = selectedBody(doc, target.tabId);
    const link = `https://docs.google.com/document/d/${target.documentId}/edit${body.tabId ? `?tab=${encodeURIComponent(body.tabId)}` : ''}`;
    if (
      contentText(body.content).includes(reportMarker(job)) ||
      body.namedRanges?.[reportRangeName(job)] ||
      doc.namedRanges?.[reportRangeName(job)]
    )
      return link;
    if (!doc.revisionId)
      throw new ReportError('The weekly log must be editable by the bot’s Google identity.');
    const start = Math.max(1, ...body.content.map((element) => (element.endIndex ?? 2) - 1));
    if (job.template?.layout) {
      if (!job.filledTemplate)
        throw new ReportError('The filled native template is missing. Nothing was appended.');
      await this.request(target.documentId, 'POST', {
        writeControl: { requiredRevisionId: doc.revisionId },
        requests: templateAppendRequests(
          job.filledTemplate,
          start,
          body.tabId,
          reportRangeName(job),
        ),
      });
      return link;
    }
    const text = `\n${job.rendered}\n${reportMarker(job)}\n`;
    const range = {
      startIndex: start,
      endIndex: start + text.length,
      ...(body.tabId ? { tabId: body.tabId } : {}),
    };
    const requests: Record<string, unknown>[] = [
      {
        insertText: {
          location: { index: start, ...(body.tabId ? { tabId: body.tabId } : {}) },
          text,
        },
      },
      {
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      {
        updateTextStyle: {
          range,
          textStyle: {},
          fields: 'bold,italic,link,foregroundColor,weightedFontFamily,fontSize',
        },
      },
    ];
    // JS lengths and Docs indexes are both UTF-16 code units, including emoji.
    let offset = start;
    for (const line of text.split('\n')) {
      if (
        line &&
        (line.startsWith('Weekly progress report | ') ||
          job.draft.sections.some((section) => section.heading === line))
      ) {
        requests.push({
          updateParagraphStyle: {
            range: { ...range, startIndex: offset, endIndex: offset + line.length },
            paragraphStyle: {
              namedStyleType: line.startsWith('Weekly progress report | ')
                ? 'HEADING_1'
                : 'HEADING_2',
            },
            fields: 'namedStyleType',
          },
        });
      }
      offset += line.length + 1;
    }
    await this.request(target.documentId, 'POST', {
      writeControl: { requiredRevisionId: doc.revisionId },
      requests,
    });
    return link;
  }
}
