import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { ReportError } from './types.js';

const credentialsSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('service_account'),
    client_email: z.string().min(1),
    private_key: z.string().min(1),
    private_key_id: z.string().optional(),
    project_id: z.string().optional(),
    quota_project_id: z.string().optional(),
  }),
  z.object({
    type: z.literal('authorized_user'),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
    quota_project_id: z.string().optional(),
  }),
]);

export function googleAuthFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const scopes = ['https://www.googleapis.com/auth/documents'];
  const raw = env.GOOGLE_CREDENTIALS_JSON?.trim();
  if (!raw)
    return new GoogleAuth({ scopes, keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS || undefined });
  // Accept only the fields needed for these two credential types. Never echo JSON,
  // parser errors, private keys, refresh tokens, or custom credential endpoints.
  try {
    const credentials = credentialsSchema.parse(JSON.parse(raw));
    if (credentials.type === 'service_account')
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    return new GoogleAuth({ credentials, scopes });
  } catch {
    throw new ReportError(
      'GOOGLE_CREDENTIALS_JSON must contain valid service_account or authorized_user credential JSON. Check the private .env file.',
    );
  }
}
