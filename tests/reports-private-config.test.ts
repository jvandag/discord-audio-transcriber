import { readFileSync } from 'node:fs';
import { JWT, UserRefreshClient } from 'google-auth-library';
import { parse as parseEnv } from 'dotenv';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/index.js';
import { configuredDestination, reportsEnvironmentOverrides } from '../src/reports/config.js';
import { googleAuthFromEnvironment } from '../src/reports/google-auth.js';
import { googleDocsRequest } from '../src/reports/google-docs.js';
import { reportOptions } from './reports-helpers.js';

afterEach(() => vi.unstubAllEnvs());
it('keeps resolved document links out of serializable public configuration', () => {
  const options = reportOptions();
  const publicConfig = JSON.stringify(options);
  expect(publicConfig).not.toContain('docs.google.com');
  expect(configuredDestination(options, 'guild-1')).toMatchObject({
    templateUrl: process.env.TEST_REPORT_TEMPLATE_URL,
    logUrl: process.env.TEST_REPORT_LOG_URL,
  });
  vi.stubEnv('TEST_REPORT_TEMPLATE_URL', 'https://docs.google.com/document/d/changed/edit');
  expect(configuredDestination(options, 'guild-1').templateUrl).toContain('/changed/');
});
it('rejects missing private URLs and literal URLs in public config', () => {
  const options = reportOptions();
  vi.stubEnv('TEST_REPORT_LOG_URL', '');
  expect(() => configuredDestination(options, 'guild-1')).toThrow('private .env');
  expect(() =>
    parseConfig({
      reports: { guilds: { guild: { templateUrl: 'private-link', logUrl: 'private-link' } } },
    }),
  ).toThrow('Unrecognized keys');
});
it('supports independent private environment variable names for each server', () => {
  const options = reportOptions();
  vi.stubEnv('OTHER_TEMPLATE_URL', 'https://docs.google.com/document/d/other-template/edit');
  vi.stubEnv('OTHER_LOG_URL', 'https://docs.google.com/document/d/other-log/edit');
  options.guilds.other = {
    ...options.guilds['guild-1']!,
    templateUrlEnv: 'OTHER_TEMPLATE_URL',
    logUrlEnv: 'OTHER_LOG_URL',
  };
  expect(configuredDestination(options, 'other').logUrl).toContain('/other-log/');
  expect(configuredDestination(options, 'guild-1').logUrl).toContain('/log/');
});
it('loads service-account JSON from .env and preserves private-key newlines', async () => {
  const credentials = {
    type: 'service_account',
    project_id: 'test',
    client_email: 'bot@test.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nTEST-KEY\n-----END PRIVATE KEY-----\n',
  };
  const env = parseEnv(`GOOGLE_CREDENTIALS_JSON='${JSON.stringify(credentials)}'\n`);
  const auth = googleAuthFromEnvironment({
    ...env,
    GOOGLE_APPLICATION_CREDENTIALS: '/unused/file.json',
  });
  const client = await auth.getClient();
  expect(client).toBeInstanceOf(JWT);
  expect(client).toMatchObject({ email: credentials.client_email, key: credentials.private_key });
});
it('also supports authorized-user OAuth credentials in .env', async () => {
  const auth = googleAuthFromEnvironment({
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({
      type: 'authorized_user',
      client_id: 'test-client',
      client_secret: 'test-secret',
      refresh_token: 'test-refresh',
    }),
  });
  expect(await auth.getClient()).toBeInstanceOf(UserRefreshClient);
});
it('rejects malformed credentials without leaking their contents', () => {
  for (const json of [
    '{private-secret:',
    JSON.stringify({ type: 'service_account', private_key: 'private-secret' }),
    JSON.stringify({
      type: 'external_account',
      token_url: 'https://untrusted.example/private-secret',
    }),
  ]) {
    try {
      googleAuthFromEnvironment({ GOOGLE_CREDENTIALS_JSON: json });
      expect.fail('Invalid credentials were accepted');
    } catch (error) {
      expect(String(error)).toContain('GOOGLE_CREDENTIALS_JSON');
      expect(String(error)).not.toContain('private-secret');
    }
  }
});
it('does not parse optional credentials until a Google request is actually made', async () => {
  vi.stubEnv('GOOGLE_CREDENTIALS_JSON', 'invalid-private-secret');
  let request!: ReturnType<typeof googleDocsRequest>;
  expect(() => {
    request = googleDocsRequest(10);
  }).not.toThrow();
  await expect(request('test', 'GET')).rejects.toThrow('GOOGLE_CREDENTIALS_JSON');
});
it('reads report setup from private environment variables instead of bot.json', () => {
  const reports = parseConfig({
    reports: reportsEnvironmentOverrides({
      REPORTS_ENABLED: 'true',
      REPORTS_PROVIDER: 'gemini',
      REPORTS_MODEL: 'gemini-3.1-flash-lite',
      REPORTS_GUILD_ID: '123456789012345678',
      REPORTS_PROJECT: 'Private team',
    }),
  }).reports;
  expect(reports).toMatchObject({
    enabled: true,
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    guilds: { '123456789012345678': { project: 'Private team' } },
  });
  expect(readFileSync('config/bot.json', 'utf8')).not.toContain('"reports"');
  expect(readFileSync('.env.example', 'utf8')).toContain('GOOGLE_CREDENTIALS_JSON');
  expect(readFileSync('.env.example', 'utf8')).toContain('REPORTS_GUILD_ID');
});
