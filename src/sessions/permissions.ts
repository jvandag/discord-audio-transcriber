import type { BotConfig } from '../config/index.js';

export function canEditAlias(
  policy: BotConfig['aliasPermissions'],
  editor: string,
  target: string,
  manageGuild: boolean,
): boolean {
  return policy === 'anyone' || (policy === 'self' && editor === target) || manageGuild;
}
export function cleanAlias(input: string): string | null {
  const name = input.trim();
  if (!name) return null;
  if (name.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name))
    throw new Error(
      'Use a name of up to 80 characters on one line, without invisible control characters.',
    );
  return name;
}
