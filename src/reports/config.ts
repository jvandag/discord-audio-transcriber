import { z } from 'zod';

const optionalBooleanEnvironmentValue = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();
const optionalIntegerEnvironmentValue = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .optional();

const reportsEnvironmentSchema = z.object({
  REPORTS_ENABLED: optionalBooleanEnvironmentValue,
  REPORTS_PROVIDER: z.enum(['openai', 'gemini']).optional(),
  REPORTS_MODEL: z.string().max(200).optional(),
  REPORTS_PUBLICATION_MODE: z.enum(['automatic', 'review']).optional(),
  REPORTS_ALLOWED_ROLE_IDS: z.string().optional(),
  REPORTS_TIMEZONE: z.string().optional(),
  REPORTS_GUIDELINES_PATH: z.string().optional(),
  REPORTS_MAX_INPUT_CHARACTERS: optionalIntegerEnvironmentValue,
  REPORTS_CHUNK_CHARACTERS: optionalIntegerEnvironmentValue,
  REPORTS_MAX_OUTPUT_TOKENS: optionalIntegerEnvironmentValue,
  REPORTS_REQUEST_TIMEOUT_SECONDS: optionalIntegerEnvironmentValue,
  REPORTS_MAX_ATTEMPTS: optionalIntegerEnvironmentValue,
  REPORTS_MAX_QUEUED_JOBS: optionalIntegerEnvironmentValue,
  REPORTS_GUILD_ID: z.string().regex(/^\d+$/, 'must be a Discord server ID').optional(),
  REPORTS_PROJECT: z.string().optional(),
  REPORTS_TEMPLATE_TAB_ID: z.string().optional(),
  REPORTS_LOG_TAB_ID: z.string().optional(),
});

export function documentTarget(value: string, tabId?: string) {
  const match =
    /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(
      value,
    );
  if (!match)
    throw new Error(
      'Use a Google Docs URL in the form https://docs.google.com/document/d/ID/edit.',
    );
  const url = new URL(value);
  return { documentId: match[1]!, tabId: tabId || url.searchParams.get('tab') || undefined };
}

export const reportsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai', 'gemini']).default('gemini'),
  model: z.string().max(200).default(''),
  publicationMode: z.enum(['automatic', 'review']).default('automatic'),
  allowedRoleIds: z.array(z.string()).default([]),
  timezone: z
    .string()
    .default('America/Los_Angeles')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid report timezone'),
  guidelinesPath: z.string().default('config/reports/guidelines.md'),
  maxInputCharacters: z.number().int().min(10000).max(1000000).default(120000),
  chunkCharacters: z.number().int().min(2000).max(100000).default(30000),
  maxOutputTokens: z.number().int().min(1000).max(32000).default(10000),
  requestTimeoutSeconds: z.number().int().min(10).max(600).default(180),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  maxQueuedJobs: z.number().int().min(1).max(100).default(10),
  guilds: z
    .record(
      z.string(),
      z
        .object({
          templateUrlEnv: z
            .string()
            .regex(/^[A-Z_][A-Z0-9_]*$/)
            .default('REPORT_TEMPLATE_URL'),
          logUrlEnv: z
            .string()
            .regex(/^[A-Z_][A-Z0-9_]*$/)
            .default('REPORT_LOG_URL'),
          templateTabId: z.string().optional(),
          logTabId: z.string().optional(),
          project: z.string().default('Not specified'),
        })
        .strict(),
    )
    .default({}),
});
export type ReportsConfig = z.infer<typeof reportsSchema>;
export type ReportDestination = Omit<
  ReportsConfig['guilds'][string],
  'templateUrlEnv' | 'logUrlEnv'
> & { templateUrl: string; logUrl: string };

/**
 * Report setup lives in .env by default so a shared bot.json contains no server
 * identifiers or project details. JSON configuration remains supported for existing
 * deployments; these values override it when present.
 */
export function reportsEnvironmentOverrides(env: NodeJS.ProcessEnv = process.env) {
  const values = reportsEnvironmentSchema.parse(env);
  const overrides: Record<string, unknown> = {};
  const directFields = {
    enabled: values.REPORTS_ENABLED,
    provider: values.REPORTS_PROVIDER,
    model: values.REPORTS_MODEL,
    publicationMode: values.REPORTS_PUBLICATION_MODE,
    timezone: values.REPORTS_TIMEZONE,
    guidelinesPath: values.REPORTS_GUIDELINES_PATH,
    maxInputCharacters: values.REPORTS_MAX_INPUT_CHARACTERS,
    chunkCharacters: values.REPORTS_CHUNK_CHARACTERS,
    maxOutputTokens: values.REPORTS_MAX_OUTPUT_TOKENS,
    requestTimeoutSeconds: values.REPORTS_REQUEST_TIMEOUT_SECONDS,
    maxAttempts: values.REPORTS_MAX_ATTEMPTS,
    maxQueuedJobs: values.REPORTS_MAX_QUEUED_JOBS,
  };
  for (const [key, value] of Object.entries(directFields)) {
    if (value !== undefined) overrides[key] = value;
  }
  if (values.REPORTS_ALLOWED_ROLE_IDS !== undefined) {
    overrides.allowedRoleIds = values.REPORTS_ALLOWED_ROLE_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  const hasGuildSetting =
    values.REPORTS_PROJECT !== undefined ||
    values.REPORTS_TEMPLATE_TAB_ID !== undefined ||
    values.REPORTS_LOG_TAB_ID !== undefined;
  if (hasGuildSetting && !values.REPORTS_GUILD_ID) {
    throw new Error('Set REPORTS_GUILD_ID when setting a report project or Google Docs tab ID.');
  }
  if (values.REPORTS_GUILD_ID) {
    overrides.guilds = {
      [values.REPORTS_GUILD_ID]: {
        project: values.REPORTS_PROJECT ?? 'Not specified',
        ...(values.REPORTS_TEMPLATE_TAB_ID
          ? { templateTabId: values.REPORTS_TEMPLATE_TAB_ID }
          : {}),
        ...(values.REPORTS_LOG_TAB_ID ? { logTabId: values.REPORTS_LOG_TAB_ID } : {}),
      },
    };
  }
  return overrides;
}

export function configuredDestination(config: ReportsConfig, guildId: string) {
  if (!config.enabled) throw new Error('Meeting reports are disabled in config/bot.json.');
  if (!config.model.trim()) throw new Error('Set reports.model to an available report model.');
  const target = config.guilds[guildId];
  if (!target)
    throw new Error(
      'Configure this server under reports.guilds and put its document URLs in .env.',
    );
  const templateUrl = process.env[target.templateUrlEnv]?.trim();
  const logUrl = process.env[target.logUrlEnv]?.trim();
  if (!templateUrl || !logUrl)
    throw new Error(
      `Set ${target.templateUrlEnv} and ${target.logUrlEnv} in the private .env file.`,
    );
  const template = documentTarget(templateUrl, target.templateTabId);
  const log = documentTarget(logUrl, target.logTabId);
  if (template.documentId === log.documentId)
    throw new Error('The report template and weekly log must be different Google Docs.');
  if (config.chunkCharacters >= config.maxInputCharacters / 2)
    throw new Error('reports.chunkCharacters must be less than half maxInputCharacters.');
  return {
    templateUrl,
    logUrl,
    templateTabId: target.templateTabId,
    logTabId: target.logTabId,
    project: target.project,
  };
}
