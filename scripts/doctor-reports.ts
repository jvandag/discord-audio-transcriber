import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/index.js';
import { configuredDestination } from '../src/reports/config.js';
import { GoogleReportDocuments, googleDocsRequest } from '../src/reports/google-docs.js';
import { checkProviderCredentials } from '../src/reports/providers.js';

const { reports } = loadConfig();
if (!reports.enabled)
  throw new Error('Set REPORTS_ENABLED=true and REPORTS_GUILD_ID in .env. See docs/reports.md.');
checkProviderCredentials(reports);
if (!(await readFile(reports.guidelinesPath, 'utf8')).trim())
  throw new Error('The report guidelines file is empty.');
const documents = new GoogleReportDocuments(googleDocsRequest(reports.requestTimeoutSeconds));
const guilds = Object.keys(reports.guilds);
if (!guilds.length) throw new Error('Set REPORTS_GUILD_ID in .env.');
for (const guildId of guilds) {
  const destination = configuredDestination(reports, guildId);
  const template = await documents.readTemplate(destination);
  const log = await documents.inspectLog(destination);
  console.log(
    `Server ${guildId}: live template "${template.title}" (${template.text.length} characters${template.layout ? `, ${template.layout.slots.filter((slot) => !slot.date).length} fillable fields` : ''}), weekly log "${log}".`,
  );
}
console.log(
  `Report configuration and Google Docs read access are ready. Provider: ${reports.provider}; model: ${reports.model}. No AI request or document write was made. Model access, billing, and an actual append still require a live test.`,
);
