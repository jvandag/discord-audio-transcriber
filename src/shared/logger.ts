import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['token', 'DISCORD_TOKEN', 'text', 'transcript'],
});
