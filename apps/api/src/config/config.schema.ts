import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  PATREON_CLIENT_ID: z.string().min(1),
  PATREON_CLIENT_SECRET: z.string().min(1),
  PATREON_REDIRECT_URI: z.string().url(),

  // 32 raw bytes, base64-encoded — the AES-256 key. The regex matters because Buffer.from
  // silently discards invalid base64 characters, so a malformed string can still decode to 32
  // bytes and slip through a length check alone. Rejected at boot rather than at the first
  // token write, and the all-zero key is refused so CI's placeholder cannot reach production.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded')
    .refine((value) => !Buffer.from(value, 'base64').equals(Buffer.alloc(32)), {
      message: 'ENCRYPTION_KEY must not be all zero bytes',
    }),

  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 14),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
});

export type AppConfig = z.infer<typeof configSchema>;
