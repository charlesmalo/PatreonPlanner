import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  PATREON_CLIENT_ID: z.string().min(1),
  PATREON_CLIENT_SECRET: z.string().min(1),
  PATREON_REDIRECT_URI: z.string().url(),

  // 32 raw bytes, base64-encoded — the AES-256 key. Rejected early so a short key fails at
  // boot rather than at the first token write.
  ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'ENCRYPTION_KEY must be 32 bytes, base64-encoded',
  }),

  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 14),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
});

export type AppConfig = z.infer<typeof configSchema>;
