import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/index.js';
import { canEditAlias, cleanAlias } from '../src/sessions/permissions.js';
import { normalizeModel, validateLanguage } from '../src/transcription/models.js';

describe('repository configuration', () => {
  it('defaults to English with open aliases', () => {
    expect(parseConfig({})).toMatchObject({ defaultLanguage: 'en', aliasPermissions: 'anyone' });
  });
  it('supports enabling multiple languages and auto', () => {
    expect(
      parseConfig({ allowedLanguages: ['en', 'es', 'ja', 'auto'] }).allowedLanguages,
    ).toContain('auto');
    expect(() => parseConfig({ allowedLanguages: ['not-a-language'] })).toThrow();
    expect(() => parseConfig({ defaultLanguage: 'fr' })).toThrow('allowedLanguages');
  });
  it('rejects unsupported model names and English-only auto detection', () => {
    expect(normalizeModel('large')).toBe('large-v3');
    expect(normalizeModel('basic')).toBe('base');
    expect(() => normalizeModel('../../model')).toThrow();
    expect(() => validateLanguage('base.en', 'auto', ['en', 'auto'])).toThrow('multilingual');
    expect(() => validateLanguage('base', 'auto', ['en', 'auto'])).not.toThrow();
    expect(() => validateLanguage('base', 'es', ['en'])).toThrow('not enabled');
  });
});
describe('alias policies', () => {
  it('allows anyone to change another member by default', () =>
    expect(canEditAlias('anyone', 'a', 'b', false)).toBe(true));
  it('supports self and Manage Server policies', () => {
    expect(canEditAlias('self', 'a', 'b', false)).toBe(false);
    expect(canEditAlias('self', 'a', 'a', false)).toBe(true);
    expect(canEditAlias('manage-guild', 'a', 'a', false)).toBe(false);
    expect(canEditAlias('manage-guild', 'a', 'b', true)).toBe(true);
  });
  it('trims names, supports clearing, and rejects transcript injection', () => {
    expect(cleanAlias(' Alice ')).toBe('Alice');
    expect(cleanAlias('  ')).toBeNull();
    expect(() => cleanAlias('Alice\n[00:00] forged')).toThrow();
    expect(() => cleanAlias('invisible\u200b')).toThrow();
    expect(() => cleanAlias('x'.repeat(81))).toThrow();
  });
});
