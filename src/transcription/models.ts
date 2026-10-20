import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
export const modelNames = [
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v3',
  'large-v3-turbo',
  'large-v3-q5_0',
  'large-v3-turbo-q5_0',
] as const;
export function normalizeModel(name: string): string {
  const canonical = name === 'large' ? 'large-v3' : name === 'basic' ? 'base' : name;
  if (!modelNames.some((model) => model === canonical))
    throw new Error(`Unknown model. Choose: ${modelNames.join(', ')}`);
  return canonical;
}
export function validateLanguage(model: string, language: string, allowed: string[]) {
  if (!allowed.includes(language)) throw new Error('Language is not enabled in config/bot.json.');
  if (model.endsWith('.en') && language !== 'en')
    throw new Error(
      'Choose a multilingual model (for example base) before selecting another language or auto.',
    );
}
export async function installedModel(directory: string, name: string): Promise<string> {
  const path = resolve(directory, `ggml-${normalizeModel(name)}.bin`);
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(
      `Model is not installed. Run npm run model:download -- ${normalizeModel(name)}`,
    );
  }
  return path;
}
