import {
  ReportError,
  type ReportDraft,
  type ReportInput,
  type ReportJob,
  type TemplateLayout,
  type TemplateParagraph,
  type TemplateSlot,
} from './types.js';

const paragraphText = (paragraph: TemplateParagraph) =>
  paragraph.runs.map((run) => run.text).join('');
const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .split(/\s+/);
const lastWeek = (section: string) => /^last week\b/i.test(section);

export function templateLayout(paragraphs: TemplateParagraph[]): TemplateLayout {
  const slots: TemplateSlot[] = [];
  let section = '';
  let label = '';
  let member: string | undefined;
  for (const [index, paragraph] of paragraphs.entries()) {
    const text = paragraphText(paragraph);
    const plain = text
      .trim()
      .replace(/^[-*#\s]+/, '')
      .replace(/\*\*/g, '');
    const placeholders = [...text.matchAll(/<([^<>\n]+)>/g)];
    if (!placeholders.length && plain) {
      if (/^(last week\b|next week\b|blocked\b)/i.test(plain)) {
        section = plain;
        label = '';
        member = undefined;
      } else if (section) {
        label = plain;
        member = /^(team review|team plan|additional details)$/i.test(plain) ? undefined : plain;
      }
    }
    for (const match of placeholders) {
      slots.push({
        id: `field_${String(slots.length + 1).padStart(4, '0')}`,
        paragraph: index,
        start: match.index!,
        end: match.index! + match[0].length,
        instruction: match[1]!,
        section,
        label,
        member,
        date: /date of (?:meeting|transcript)|meeting\s*\/\s*transcript|^date$/i.test(match[1]!),
      });
    }
  }
  if (!slots.some((slot) => !slot.date))
    throw new ReportError('The report template must contain <instruction> placeholders to fill.');
  return { paragraphs, slots };
}

export function templateMembers(layout: TemplateLayout, input: ReportInput) {
  const names = [...new Set(layout.slots.flatMap((slot) => (slot.member ? [slot.member] : [])))];
  return names.map((name) => {
    const tokens = normalize(name);
    const matches = input.speakers.filter((speaker) => {
      const candidate = normalize(speaker.name);
      if (candidate.join(' ') === tokens.join(' ')) return true;
      return (
        candidate[0] === tokens[0] &&
        candidate.length > 1 &&
        tokens.length > 1 &&
        (tokens.at(-1)!.startsWith(candidate.at(-1)!) ||
          candidate.at(-1)!.startsWith(tokens.at(-1)!))
      );
    });
    const unique = matches.filter(
      (speaker) =>
        names.filter((other) => {
          const parts = normalize(other);
          const alias = normalize(speaker.name);
          return (
            parts[0] === alias[0] &&
            (parts.at(-1)!.startsWith(alias.at(-1)!) || alias.at(-1)!.startsWith(parts.at(-1)!))
          );
        }).length === 1,
    );
    return { name, speakerId: unique.length === 1 ? unique[0]!.id : null };
  });
}

export function templateFields(layout: TemplateLayout) {
  return layout.slots
    .filter((slot) => !slot.date)
    .map(({ id, instruction, section, label, member }) => ({
      id,
      instruction,
      section,
      label,
      member,
    }));
}

export function validateTemplateDraft(draft: ReportDraft, layout: TemplateLayout): ReportDraft {
  const expected = layout.slots.filter((slot) => !slot.date).map((slot) => slot.id);
  const actual = draft.sections.map((section) => section.heading);
  if (
    expected.length !== actual.length ||
    new Set(actual).size !== actual.length ||
    expected.some((id) => !actual.includes(id))
  )
    throw new ReportError(
      'Fill every template field exactly once in the fields array using its exact fieldId. Do not use section labels as IDs, or add or omit fields.',
    );
  return draft;
}

export function filledTemplate(job: ReportJob, input: ReportInput): TemplateParagraph[] {
  const layout = job.template?.layout;
  if (!layout || !job.draft)
    throw new ReportError('The saved template layout or report draft is missing.');
  validateTemplateDraft(job.draft, layout);
  const members = templateMembers(layout, input);
  const replacements = new Map<string, string>();
  for (const slot of layout.slots) {
    if (slot.date) {
      replacements.set(
        slot.id,
        new Intl.DateTimeFormat('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: job.options.timezone,
        }).format(input.meetingStartedAt),
      );
      continue;
    }
    const section = job.draft.sections.find((item) => item.heading === slot.id)!;
    let text = section.entries.map((entry) => entry.text).join(' ');
    if (
      /^additional details$/i.test(slot.label) &&
      section.entries.every((entry) => entry.kind === 'missing')
    )
      text = '';
    if (
      slot.member &&
      lastWeek(slot.section) &&
      !members.find((member) => member.name === slot.member)?.speakerId
    ) {
      const details = section.entries
        .filter((entry) => entry.kind === 'fact')
        .map((entry) => entry.text)
        .join(' ');
      text = `Not present for meeting.${details ? ` ${details}` : ''}`;
    }
    replacements.set(slot.id, text);
  }
  return layout.paragraphs.map((paragraph, index) => {
    const slots = layout.slots.filter((slot) => slot.paragraph === index);
    const text = paragraphText(paragraph);
    const output: TemplateParagraph = { ...paragraph, runs: [] };
    const slice = (start: number, end: number) => {
      let position = 0;
      for (const run of paragraph.runs) {
        const left = Math.max(start, position),
          right = Math.min(end, position + run.text.length);
        if (right > left)
          output.runs.push({
            ...run,
            text: run.text.slice(left - position, right - position),
            style: structuredClone(run.style),
          });
        position += run.text.length;
      }
    };
    let cursor = 0;
    for (const slot of slots) {
      slice(cursor, slot.start);
      let position = 0;
      const source = paragraph.runs.find((run) => {
        const found = position + run.text.length > slot.start;
        position += run.text.length;
        return found;
      });
      // Placeholder instruction links do not belong on generated prose.
      const style = { ...source?.style };
      delete style.link;
      output.runs.push({ text: replacements.get(slot.id)!, style });
      cursor = slot.end;
    }
    slice(cursor, text.length);
    return output;
  });
}

export function templateText(paragraphs: TemplateParagraph[]) {
  return paragraphs.map(paragraphText).join('');
}

export function templateAppendRequests(
  paragraphs: TemplateParagraph[],
  start: number,
  tabId: string,
  name: string,
) {
  const range = (startIndex: number, endIndex: number) => ({
    startIndex,
    endIndex,
    ...(tabId ? { tabId } : {}),
  });
  let rawOffset = start + 1,
    finalOffset = start + 1;
  const positions = paragraphs.map((paragraph) => {
    const text = paragraphText(paragraph);
    const tabs = paragraph.nestingLevel ?? 0;
    const position = { paragraph, text, tabs, rawStart: rawOffset, finalStart: finalOffset };
    rawOffset += tabs + text.length;
    finalOffset += text.length;
    return position;
  });
  const text = '\n' + positions.map((item) => '\t'.repeat(item.tabs) + item.text).join('');
  const requests: Record<string, unknown>[] = [
    { insertText: { location: { index: start, ...(tabId ? { tabId } : {}) }, text } },
  ];
  requests.push({ deleteParagraphBullets: { range: range(start + 1, start + text.length) } });
  // Reverse order prevents removal of nesting tabs from invalidating earlier ranges.
  for (const item of [...positions].reverse())
    if (item.paragraph.nestingLevel !== undefined)
      requests.push({
        createParagraphBullets: {
          range: range(item.rawStart, item.rawStart + item.tabs + item.text.length),
          bulletPreset: item.paragraph.bulletPreset ?? 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
  requests.push({
    updateTextStyle: {
      range: range(start + 1, finalOffset),
      textStyle: {},
      fields:
        'bold,italic,underline,strikethrough,link,foregroundColor,backgroundColor,weightedFontFamily,fontSize,baselineOffset,smallCaps',
    },
  });
  for (const item of positions) {
    const paragraphRange = range(item.finalStart, item.finalStart + item.text.length);
    if (Object.keys(item.paragraph.style).length)
      requests.push({
        updateParagraphStyle: {
          range: paragraphRange,
          paragraphStyle: item.paragraph.style,
          fields: Object.keys(item.paragraph.style).join(','),
        },
      });
    let offset = item.finalStart;
    for (const run of item.paragraph.runs) {
      const length = run.text.length;
      // Docs resolves newly inserted person chips itself and forbids a display
      // name on insertion. Retain the template's exact visible name and email
      // destination using a normal mailto link instead of a renamed chip.
      const style = run.person
        ? { ...run.style, link: { url: `mailto:${run.person.email}` } }
        : run.style;
      if (length && Object.keys(style).length)
        requests.push({
          updateTextStyle: {
            range: range(offset, offset + length),
            textStyle: style,
            fields: Object.keys(style).join(','),
          },
        });
      offset += length;
    }
  }
  requests.push({ createNamedRange: { name, range: range(start + 1, finalOffset) } });
  return requests;
}
