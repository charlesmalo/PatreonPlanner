import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Billing. Optional as a set: an instance with no payment provider configured runs perfectly
  // well — nobody is premium, every gate stays closed, and the webhook endpoint refuses because
  // it has no secret to verify against. That is the correct behaviour for development, for the
  // end-to-end stack, and for anybody self-hosting who does not want to sell anything.
  LEMONSQUEEZY_WEBHOOK_SECRET: z.string().min(1).optional(),
  LEMONSQUEEZY_CHECKOUT_URL: z.string().url().optional(),
  // Only reconciliation needs this — asking the provider what a subscription is really doing when
  // a webhook never arrived. Absent means that safety net is off, not that billing is broken.
  LEMONSQUEEZY_API_KEY: z.string().min(1).optional(),
  LEMONSQUEEZY_API_BASE_URL: z.string().url().default('https://api.lemonsqueezy.com'),

  /**
   * Where this API is reachable from a browser. Only the fake provider's checkout stand-in needs
   * it, because it is the one checkout URL this application serves itself — a real provider hosts
   * its own and tells us the address.
   */
  /**
   * Which payment provider this instance runs.
   *
   * Defaults to the real one. An unconfigured `lemonsqueezy` sells nothing and refuses every
   * webhook, which is the correct state for development, for CI, and for anybody self-hosting who
   * does not want to sell anything — so there is no separate "none".
   */
  BILLING_PROVIDER: z.enum(['lemonsqueezy', 'fake']).default('lemonsqueezy'),
  /**
   * Permission for the one combination that is otherwise refused at boot.
   *
   * The fake provider grants premium to anyone who asks. Selecting it under NODE_ENV=production
   * aborts the boot unless this is *also* set — two keys rather than one, because one is a typo
   * away from giving the product away, and a hosted demo is a legitimate reason to want it.
   */
  ALLOW_FAKE_BILLING_IN_PRODUCTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /**
   * What the fake provider signs its payloads with.
   *
   * It has a default because it protects nothing: there is no money behind it, and both the signer
   * and the verifier are this process. The code path it drives is the real one, which is the point
   * — a fake purchase goes through genuine HMAC verification rather than around it.
   */
  FAKE_BILLING_SECRET: z.string().min(1).default('fake-billing-secret'),

  // Digests. Optional as a set: no key means no email, and the app runs exactly as it does now.
  // How often the background tick fires. Fifteen minutes suits a deployment; the demo stack sets
  // it to seconds, because a playtester who queues something and watches nothing happen for a
  // quarter of an hour concludes it is broken rather than slow.
  JOB_TICK_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),

  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_API_BASE_URL: z.string().url().default('https://api.resend.com'),
  /**
   * Verifies bounce and complaint deliveries. Svix format — `whsec_` and then base64.
   *
   * Separate from the API key because it is a different secret with a different blast radius: the
   * key sends mail, this one only proves an inbound request is real. Absent means the endpoint
   * refuses everything, which is correct for an instance that sends no mail.
   */
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Must be an address on a domain with SPF and DKIM pointing at the provider, or the mail lands
  // in spam and the free tier is spent on messages nobody sees.
  DIGEST_FROM: z.string().min(1).default('PatreonPlanner <noreply@localhost>'),

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
  // The regions callers may ask for. Bounded on purpose: the region is a free parameter on a
  // VIEW-gated route, so without a list one caller could drive 676 upstream lookups for a single
  // title and leave 676 rows in the refresh job's working set forever.
  AVAILABILITY_REGIONS: z
    .string()
    .regex(/^[A-Z]{2}(,[A-Z]{2})*$/, 'must be comma-separated ISO-3166-1 country codes')
    .default('US,GB,CA,AU,IE,NZ,DE,FR,ES,IT,JP,BR,MX'),

  // Word-similarity cut-off for board search. Corpus-dependent — a board of long titles matches
  // more loosely than one of short ones — so it is operational rather than a constant.
  SEARCH_SIMILARITY_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.3),

  /**
   * How many proxies sit in front of the API. Getting this wrong is silent in both directions —
   * too high and a client forges its address, too low and everyone behind the proxy shares one
   * bucket — so it defaults to the safe-but-useless answer and warns at boot.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Generous velocity caps, not quotas (design §6.2): a person using the product normally must
  // never reach them.
  COARSE_LIMIT_BURST: z.coerce.number().int().positive().default(60),
  COARSE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  SEARCH_LIMIT_BURST: z.coerce.number().int().positive().default(30),
  SEARCH_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

  /**
   * Semantic search. Off by default: the model downloads on first use and costs ~250–400MB
   * resident, which is a decision a deployment should make rather than inherit.
   */
  EMBEDDINGS_ENABLED: z
    .string()
    .transform((value) => value === 'true')
    .or(z.boolean())
    .default(false),
  EMBEDDING_MODEL: z.string().min(1).default('Xenova/multilingual-e5-small'),
  /**
   * Where the model is cached.
   *
   * Needs a default that is writable, because transformers' own default is not: it caches inside
   * its package directory under `node_modules`, and the API image runs as `node`. Every load
   * failed with EACCES, and the provider's graceful fallback meant semantic search degraded to
   * trigram in any containerised deployment while looking exactly like one with embeddings off.
   *
   * A deployment that wants the model to survive a restart should point this at a mounted volume;
   * the default re-downloads roughly 120MB after each one.
   */
  EMBEDDING_CACHE_DIR: z.string().min(1).default(join(tmpdir(), 'patreonplanner-embeddings')),
  // Must match the width of the `Title.embedding` column; changing it needs a migration.
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),
  /**
   * How far a vector may be and still count as a match, as pgvector cosine distance (0..2).
   *
   * Nearest-neighbour with no floor returns the closest rows however far away they are, so on a
   * small board every query matched everything — including the submit form's "already on the
   * board — upvote instead?" prompt, which is worse wrong than missing.
   *
   * 0.208, measured against 28 queries over six titles carrying name, aliases and overview:
   *
   *   should match    16 queries   worst 0.2060
   *   should not      12 queries   best  0.2118
   *
   * **The usable gap is 0.006 wide**, and 0.208 sits inside it with roughly 0.002 either side.
   * That is not a comfortable margin and should not be described as one — an earlier version of
   * this comment claimed 0.015 from eleven measurements over three titles, and widening the set
   * both shrank the gap and showed the old value of 0.205 rejecting a fair query ("a child working
   * to rescue her parents", 0.2060).
   *
   * Set toward recall on purpose. Missing a duplicate is the failure this feature exists to
   * prevent; showing a stray suggestion merely annoys, and trigram runs independently and catches
   * anything matching by spelling — so a floor set slightly loose costs a little noise and a floor
   * set slightly tight costs the thing itself.
   *
   * Expect it to narrow further as a board grows, since more titles means more chances for
   * something unrelated to land close. A rise in wrong "already on the board?" prompts is the
   * signal to measure again, and the numbers belong to this model: change `EMBEDDING_MODEL` and
   * none of them transfer.
   */
  EMBEDDING_MAX_DISTANCE: z.coerce.number().positive().default(0.208),

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
