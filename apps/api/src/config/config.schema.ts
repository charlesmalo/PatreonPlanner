import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  PATREON_CLIENT_ID: z.string().min(1),
  PATREON_CLIENT_SECRET: z.string().min(1),
  PATREON_REDIRECT_URI: z.string().url(),
  // Split because one is browser-facing and the other server-facing: the consent redirect is
  // followed by the user's browser, while token/identity/campaign calls come from this process.
  // In production both are patreon.com; end-to-end tests point them at a stub.
  PATREON_OAUTH_BASE_URL: z.string().url().default('https://www.patreon.com'),
  PATREON_API_BASE_URL: z.string().url().default('https://www.patreon.com'),

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

  // Optional: without it, mainstream search and submissions are refused while EXTERNAL_LINK
  // keeps working. Requiring it would mean no developer and no CI run could boot the API.
  TMDB_API_KEY: z.string().min(1).optional(),
  TMDB_API_BASE_URL: z.string().url().default('https://api.themoviedb.org/3'),
  // ISO-3166-1 alpha-2. Availability is meaningless without a region, and guessing one from the
  // request would answer the wrong question for anyone travelling or behind a VPN.
  AVAILABILITY_REGION_DEFAULT: z
    .string()
    .regex(/^[A-Z]{2}$/, 'must be a two-letter ISO-3166-1 country code')
    .default('US'),
  // How long a stored availability row is served without re-asking upstream.
  AVAILABILITY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  SUBMIT_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(1),
  // Design §6 item 3: a looser cap across all creators, so a patron of twenty creators cannot
  // submit twenty an hour.
  SUBMIT_LIMIT_PER_HOUR_GLOBAL: z.coerce.number().int().positive().default(5),
  MEMBERSHIP_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // Disabled in tests, where a scheduler firing mid-assertion is pure flake.
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type AppConfig = z.infer<typeof configSchema>;
