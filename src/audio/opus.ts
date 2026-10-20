import { createRequire } from 'node:module';
// @discordjs/opus is CommonJS and does not expose reliable ESM named exports.
const opus = createRequire(import.meta.url)('@discordjs/opus') as typeof import('@discordjs/opus');
export const OpusDecoder = opus.OpusEncoder;
