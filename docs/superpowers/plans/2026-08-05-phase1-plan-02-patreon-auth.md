# Patreon Authentication & Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Patreon user log in via OAuth, receive a server-side session, and have their identity and patron memberships persisted — so later plans can make authorization decisions.

**Architecture:** `GET /auth/patreon/login` issues a `state` + PKCE challenge held in Redis and redirects to Patreon. `GET /auth/patreon/callback` verifies `state`, exchanges the code server-side, fetches the Patreon identity, upserts `User` + `Membership`, and mints a session. Sessions live in Redis keyed by a SHA-256 hash of an opaque token; the raw token only ever exists in an httpOnly cookie. Patreon OAuth tokens are encrypted with AES-256-GCM before they touch Postgres. All Patreon HTTP calls sit behind a `PatreonClient` interface so tests run against a fake with recorded fixtures — no network, no real credentials.

**Tech Stack:** NestJS 10, Prisma 5.20 (first models + first migration), ioredis, Node 20 `node:crypto` and native `fetch`, `class-validator`/`class-transformer` DTOs, `cookie-parser`, Jest + supertest + Testcontainers.

## Global Constraints

Copied verbatim from design §9 (Security Requirements); every task's requirements implicitly include these.

- **No credentials in URLs:** session tokens never appear in URLs. Patreon's `?code=` is single-use, short-lived, exchanged server-side over HTTPS, hardened with **PKCE + `state`**.
- **Secret handling & timing:** no plaintext secrets; Patreon tokens **encrypted at rest**; **constant-time comparison** for webhook signatures and session tokens.
- **Generic errors:** no user-enumeration; generic client messages; no stack traces/SQL/secrets in responses; **secrets never logged** (redaction).
- **Input validation:** `class-validator` DTOs on every endpoint (types, lengths, formats, malformed-body rejection).
- **Sessions & cookies:** server-side session in Redis; cookie `HttpOnly` + `Secure` + `SameSite`; **rotation after login**, **invalidation on logout**, sane expiry; **CSRF tokens** on state-changing requests.
- **SQL injection:** Prisma parameterizes everything; no string-built SQL; `$queryRaw` only via tagged-template bound params.
- **Identifier normalization:** Patreon IDs are canonical keys; any slug normalization is explicit with DB-level uniqueness.
- **Resource safety:** Prisma-managed pooling/transactions; no hand-rolled connection lifecycles.

## Scope

**In scope:** first Prisma models and migration (`User`, `Creator`, `Tier`, `Membership`), config extension, token encryption, Patreon API client + fake, Redis session store, login/callback/logout/`/me`, CSRF for state-changing requests.

**Out of scope — deliberately deferred:**

- **Creator claiming** (design §4 "Creator claiming") → Plan 03. Plan 02 creates no `Creator` rows; membership sync only touches campaigns already present in the database.
- **`CreatorAccessGuard`, `CreatorPolicy`, `CreatorStaff`** (design §4 "Access enforcement") → Plan 03. Plan 02 ships `SessionGuard` (authentication) only, never authorization.
- **Patreon webhooks** (design §4 "Keeping tier status fresh", primary path) → Plan 04. Plan 02 implements only the login-time re-sync fallback.
- **Token refresh background job** → Plan 04. Plan 02 stores `tokenExpiresAt` so the job has something to act on.

## Prerequisites

Plan 01 must be complete (`PrismaService`, `RedisService`, `ConfigService`, `/healthz`, `/readyz`).

**Patreon credentials are NOT required to implement or test this plan.** Every test runs against `FakePatreonClient`. A real client ID/secret is only needed for manual end-to-end verification, which is called out as optional in Task 8.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/api/prisma/schema.prisma` | Add `User`, `Creator`, `Tier`, `Membership` |
| `apps/api/prisma/migrations/*` | First migration |
| `apps/api/test/support/database.ts` | Start Postgres container + apply migrations for integration tests |
| `apps/api/src/config/config.schema.ts` | Patreon + crypto env vars |
| `apps/api/src/crypto/encryption.service.ts` | AES-256-GCM encrypt/decrypt of Patreon tokens |
| `apps/api/src/crypto/crypto.module.ts` | Exports `EncryptionService` |
| `apps/api/src/patreon/patreon.types.ts` | `PatreonTokens`, `PatreonIdentity`, `PatreonMembership` |
| `apps/api/src/patreon/patreon.client.ts` | `PatreonClient` interface + `PATREON_CLIENT` token |
| `apps/api/src/patreon/http-patreon.client.ts` | Real implementation over `fetch` |
| `apps/api/src/patreon/patreon.module.ts` | Binds `PATREON_CLIENT` |
| `apps/api/test/support/fake-patreon.client.ts` | Deterministic fake used by every test |
| `apps/api/src/session/session.service.ts` | Create/read/rotate/destroy sessions in Redis |
| `apps/api/src/session/session.module.ts` | Exports `SessionService` |
| `apps/api/src/session/session.guard.ts` | `SessionGuard` + `@CurrentUser()` decorator |
| `apps/api/src/auth/oauth-state.service.ts` | PKCE verifier + `state` lifecycle in Redis |
| `apps/api/src/auth/auth.service.ts` | Callback orchestration: exchange → identity → upsert → session |
| `apps/api/src/auth/auth.controller.ts` | `/auth/patreon/login`, `/auth/patreon/callback`, `/auth/logout`, `/me` |
| `apps/api/src/auth/auth.module.ts` | Wiring |
| `apps/api/src/csrf/csrf.middleware.ts` | Double-submit CSRF for state-changing requests |

---

## Task 1: First Prisma models, migration & integration-test database harness

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/` (generated)
- Create: `apps/api/test/support/database.ts`
- Test: `apps/api/test/user-model.int-spec.ts`
- Modify: `apps/api/package.json` (drop `--allow-no-models`)

**Interfaces:**

- Consumes: `PrismaService` (Plan 01).
- Produces: Prisma models `User`, `Creator`, `Tier`, `Membership`. Test helper `startDatabase(): Promise<StartedPostgreSqlContainer>` which starts Postgres **and applies migrations**, so every later integration test gets a schema-ready database.

- [ ] **Step 1: Add the models to `apps/api/prisma/schema.prisma`**

Append below the existing `datasource` block (leave `generator`/`datasource` untouched):

```prisma
model User {
  id                    String    @id @default(uuid()) @db.Uuid
  patreonUserId         String    @unique
  fullName              String?
  email                 String?
  avatarUrl             String?
  accessTokenEncrypted  String?
  refreshTokenEncrypted String?
  tokenExpiresAt        DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  ownedCreators Creator[]    @relation("CreatorOwner")
  memberships   Membership[]
}

model Creator {
  id                String   @id @default(uuid()) @db.Uuid
  patreonCampaignId String   @unique
  ownerUserId       String   @db.Uuid
  displayName       String
  slug              String   @unique
  claimedAt         DateTime @default(now())
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  owner       User         @relation("CreatorOwner", fields: [ownerUserId], references: [id])
  tiers       Tier[]
  memberships Membership[]
}

model Tier {
  id            String   @id @default(uuid()) @db.Uuid
  creatorId     String   @db.Uuid
  patreonTierId String
  title         String
  amountCents   Int
  order         Int
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  creator     Creator      @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  memberships Membership[]

  @@unique([creatorId, patreonTierId])
}

model Membership {
  id             String   @id @default(uuid()) @db.Uuid
  userId         String   @db.Uuid
  creatorId      String   @db.Uuid
  currentTierId  String?  @db.Uuid
  amountCents    Int      @default(0)
  isActivePatron Boolean  @default(false)
  lastSyncedAt   DateTime @default(now())
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user        User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  creator     Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  currentTier Tier?   @relation(fields: [currentTierId], references: [id])

  @@unique([userId, creatorId])
}
```

- [ ] **Step 2: Drop `--allow-no-models` from the generate script**

In `apps/api/package.json`, change:

```json
"prisma:generate": "prisma generate --allow-no-models",
```

to:

```json
"prisma:generate": "prisma generate",
```

The flag existed only because Plan 01's schema had no models. Removing it restores the guard: a schema that accidentally yields zero models now fails loudly again.

- [ ] **Step 3: Create the migration**

Ensure compose is up (`docker compose up -d`) and `.env` has a working `DATABASE_URL`, then run:

```bash
cd apps/api && pnpm prisma migrate dev --name init_auth_models
```

Expected: `apps/api/prisma/migrations/<timestamp>_init_auth_models/migration.sql` is created and applied; `Generated Prisma Client` printed.

- [ ] **Step 4: Write the integration-test database helper**

`apps/api/test/support/database.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Starts a throwaway Postgres and applies the committed migrations to it. Tests get the real
 * schema rather than a hand-built one, so a missing migration fails the suite instead of
 * silently passing against a shape that only exists in test code.
 */
export async function startDatabase(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: 'pipe',
  });
  return container;
}
```

- [ ] **Step 5: Write the failing model test**

`apps/api/test/user-model.int-spec.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startDatabase } from './support/database';

describe('User model (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  it('enforces a unique patreonUserId', async () => {
    await prisma.user.create({ data: { patreonUserId: 'patreon-1', fullName: 'Ada' } });
    await expect(
      prisma.user.create({ data: { patreonUserId: 'patreon-1', fullName: 'Imposter' } }),
    ).rejects.toThrow();
  });

  it('enforces one membership per user per creator', async () => {
    const user = await prisma.user.create({ data: { patreonUserId: 'patreon-2' } });
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'campaign-1',
        ownerUserId: user.id,
        displayName: 'Ada Writes',
        slug: 'ada-writes',
      },
    });
    await prisma.membership.create({ data: { userId: user.id, creatorId: creator.id } });
    await expect(
      prisma.membership.create({ data: { userId: user.id, creatorId: creator.id } }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- user-model`
Expected: PASS (2 tests). If `migrate deploy` fails, the migration from Step 3 was not committed to `prisma/migrations/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): first prisma models for users, creators, tiers and memberships"
```

---

## Task 2: Config extension & Patreon token encryption

**Files:**

- Modify: `apps/api/src/config/config.schema.ts`
- Modify: `.env.example`
- Create: `apps/api/src/crypto/encryption.service.ts`, `apps/api/src/crypto/crypto.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/encryption.e2e-spec.ts`

**Interfaces:**

- Consumes: `ConfigService.get()` (Plan 01).
- Produces: `EncryptionService.encrypt(plaintext: string): string` and `.decrypt(payload: string): string`. `CryptoModule` is `@Global()` and exports `EncryptionService`. New config keys: `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_REDIRECT_URI`, `ENCRYPTION_KEY`, `SESSION_TTL_SECONDS`, `WEB_ORIGIN`.

- [ ] **Step 1: Extend the config schema**

Replace `apps/api/src/config/config.schema.ts`:

```ts
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
  ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'ENCRYPTION_KEY must be 32 bytes, base64-encoded',
    }),

  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 14),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
});

export type AppConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 2: Extend `.env.example`**

Append:

```
PATREON_CLIENT_ID=replace-me
PATREON_CLIENT_SECRET=replace-me
PATREON_REDIRECT_URI=http://localhost:3000/auth/patreon/callback
# Generate with: openssl rand -base64 32
ENCRYPTION_KEY=replace-me
SESSION_TTL_SECONDS=1209600
WEB_ORIGIN=http://localhost:5173
```

Then add the same keys to your local `.env` (generate a real `ENCRYPTION_KEY` with `openssl rand -base64 32`) and to the `env:` block of `.github/workflows/ci.yml`, using literal test values there — CI has no secrets and needs none for this plan:

```yaml
      PATREON_CLIENT_ID: test-client-id
      PATREON_CLIENT_SECRET: test-client-secret
      PATREON_REDIRECT_URI: http://localhost:3000/auth/patreon/callback
      ENCRYPTION_KEY: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
```

- [ ] **Step 3: Write the failing encryption test**

`apps/api/test/encryption.e2e-spec.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { EncryptionService } from '../src/crypto/encryption.service';
import { ConfigService } from '../src/config/config.module';

describe('EncryptionService', () => {
  const key = randomBytes(32).toString('base64');
  let service: EncryptionService;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = key;
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PATREON_CLIENT_ID = 'id';
    process.env.PATREON_CLIENT_SECRET = 'secret';
    process.env.PATREON_REDIRECT_URI = 'http://localhost:3000/auth/patreon/callback';
    service = new EncryptionService(new ConfigService());
  });

  it('round-trips a token', () => {
    const plaintext = 'patreon-access-token-value';
    expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
  });

  it('never emits the plaintext in the ciphertext payload', () => {
    const payload = service.encrypt('super-secret-token');
    expect(payload).not.toContain('super-secret-token');
  });

  it('produces a different ciphertext each time for the same input', () => {
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('rejects a tampered payload rather than returning garbage', () => {
    const payload = service.encrypt('token');
    const [version, iv, tag, data] = payload.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64')].join(':');
    expect(() => service.decrypt(tampered)).toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- encryption`
Expected: FAIL — cannot find module `../src/crypto/encryption.service`.

- [ ] **Step 5: Implement `EncryptionService`**

`apps/api/src/crypto/encryption.service.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
// Payloads carry a version tag so the key/algorithm can be rotated later without guessing
// how an existing row was written.
const VERSION = 'v1';

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.get('ENCRYPTION_KEY'), 'base64');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== VERSION) throw new Error('Unsupported ciphertext version');
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64'));
    // GCM verifies this tag on final(); a tampered payload throws instead of decrypting.
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
```

`apps/api/src/crypto/crypto.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

@Global()
@Module({ providers: [EncryptionService], exports: [EncryptionService] })
export class CryptoModule {}
```

- [ ] **Step 6: Register `CryptoModule` in `AppModule`**

In `apps/api/src/app.module.ts`, import `CryptoModule` and add it to `imports` after `ConfigModule`:

```ts
@Module({ imports: [ConfigModule, CryptoModule, PrismaModule, RedisModule, HealthModule] })
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- encryption`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): patreon oauth config and aes-256-gcm token encryption"
```

---

## Task 3: Patreon API client behind an interface, plus a fake

**Files:**

- Create: `apps/api/src/patreon/patreon.types.ts`, `apps/api/src/patreon/patreon.client.ts`, `apps/api/src/patreon/http-patreon.client.ts`, `apps/api/src/patreon/patreon.module.ts`
- Create: `apps/api/test/support/fake-patreon.client.ts`
- Test: `apps/api/test/patreon-client.e2e-spec.ts`

**Interfaces:**

- Consumes: `ConfigService`.
- Produces: injection token `PATREON_CLIENT`; interface `PatreonClient` with `buildAuthorizationUrl(params: { state: string; codeChallenge: string }): string`, `exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens>`, `fetchIdentity(accessToken: string): Promise<PatreonIdentity>`. `FakePatreonClient` implements the same interface for tests.

- [ ] **Step 1: Define the types**

`apps/api/src/patreon/patreon.types.ts`:

```ts
export interface PatreonTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface PatreonMembership {
  campaignId: string;
  patreonTierIds: string[];
  amountCents: number;
  isActivePatron: boolean;
}

export interface PatreonIdentity {
  patreonUserId: string;
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
  memberships: PatreonMembership[];
}
```

- [ ] **Step 2: Define the interface and injection token**

`apps/api/src/patreon/patreon.client.ts`:

```ts
import { PatreonIdentity, PatreonTokens } from './patreon.types';

export const PATREON_CLIENT = Symbol('PATREON_CLIENT');

export interface PatreonClient {
  buildAuthorizationUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens>;
  fetchIdentity(accessToken: string): Promise<PatreonIdentity>;
}
```

- [ ] **Step 3: Implement the HTTP client**

`apps/api/src/patreon/http-patreon.client.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { PatreonClient } from './patreon.client';
import { PatreonIdentity, PatreonMembership, PatreonTokens } from './patreon.types';

const AUTHORIZE_URL = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const IDENTITY_URL = 'https://www.patreon.com/api/oauth2/v2/identity';

@Injectable()
export class HttpPatreonClient implements PatreonClient {
  private readonly logger = new Logger(HttpPatreonClient.name);

  constructor(private readonly config: ConfigService) {}

  buildAuthorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.get('PATREON_CLIENT_ID'),
      redirect_uri: this.config.get('PATREON_REDIRECT_URI'),
      scope: 'identity identity[email] identity.memberships',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: this.config.get('PATREON_CLIENT_ID'),
        client_secret: this.config.get('PATREON_CLIENT_SECRET'),
        redirect_uri: this.config.get('PATREON_REDIRECT_URI'),
        code_verifier: codeVerifier,
      }),
    });
    if (!response.ok) {
      // Body may echo the code or client_secret; log status only.
      this.logger.warn(`Patreon token exchange failed with status ${response.status}`);
      throw new Error('Patreon token exchange failed');
    }
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
    };
  }

  async fetchIdentity(accessToken: string): Promise<PatreonIdentity> {
    const params = new URLSearchParams({
      include: 'memberships,memberships.campaign,memberships.currently_entitled_tiers',
      'fields[user]': 'full_name,email,image_url',
      'fields[member]': 'patron_status,currently_entitled_amount_cents',
    });
    const response = await fetch(`${IDENTITY_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      this.logger.warn(`Patreon identity fetch failed with status ${response.status}`);
      throw new Error('Patreon identity fetch failed');
    }
    return this.parseIdentity(await response.json());
  }

  /**
   * Patreon returns JSON:API, where memberships arrive in a flat `included` array cross-linked
   * by id. Flatten it here so nothing downstream has to understand that shape.
   */
  private parseIdentity(payload: unknown): PatreonIdentity {
    const body = payload as {
      data: {
        id: string;
        attributes?: { full_name?: string; email?: string; image_url?: string };
        relationships?: { memberships?: { data?: Array<{ id: string }> } };
      };
      included?: Array<{
        id: string;
        type: string;
        attributes?: { patron_status?: string; currently_entitled_amount_cents?: number };
        relationships?: {
          campaign?: { data?: { id: string } };
          currently_entitled_tiers?: { data?: Array<{ id: string }> };
        };
      }>;
    };

    const memberIds = new Set((body.data.relationships?.memberships?.data ?? []).map((m) => m.id));
    const memberships: PatreonMembership[] = (body.included ?? [])
      .filter((entry) => entry.type === 'member' && memberIds.has(entry.id))
      .map((entry) => ({
        campaignId: entry.relationships?.campaign?.data?.id ?? '',
        patreonTierIds: (entry.relationships?.currently_entitled_tiers?.data ?? []).map(
          (tier) => tier.id,
        ),
        amountCents: entry.attributes?.currently_entitled_amount_cents ?? 0,
        isActivePatron: entry.attributes?.patron_status === 'active_patron',
      }))
      .filter((membership) => membership.campaignId !== '');

    return {
      patreonUserId: body.data.id,
      fullName: body.data.attributes?.full_name ?? null,
      email: body.data.attributes?.email ?? null,
      avatarUrl: body.data.attributes?.image_url ?? null,
      memberships,
    };
  }
}
```

- [ ] **Step 4: Bind the token in a module**

`apps/api/src/patreon/patreon.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PATREON_CLIENT } from './patreon.client';
import { HttpPatreonClient } from './http-patreon.client';

@Global()
@Module({
  providers: [{ provide: PATREON_CLIENT, useClass: HttpPatreonClient }],
  exports: [PATREON_CLIENT],
})
export class PatreonModule {}
```

Register `PatreonModule` in `AppModule`'s `imports`.

- [ ] **Step 5: Write the fake**

`apps/api/test/support/fake-patreon.client.ts`:

```ts
import { PatreonClient } from '../../src/patreon/patreon.client';
import { PatreonIdentity, PatreonTokens } from '../../src/patreon/patreon.types';

/**
 * Records what it was called with so tests can assert the PKCE verifier actually reached the
 * exchange, and returns fixed data so assertions stay deterministic.
 */
export class FakePatreonClient implements PatreonClient {
  public exchangeCalls: Array<{ code: string; codeVerifier: string }> = [];
  public identity: PatreonIdentity = {
    patreonUserId: 'patreon-user-1',
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    avatarUrl: 'https://example.com/ada.png',
    memberships: [],
  };
  public exchangeShouldFail = false;

  buildAuthorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
    return `https://patreon.test/oauth2/authorize?state=${state}&code_challenge=${codeChallenge}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens> {
    this.exchangeCalls.push({ code, codeVerifier });
    if (this.exchangeShouldFail) throw new Error('Patreon token exchange failed');
    return { accessToken: 'access-token', refreshToken: 'refresh-token', expiresInSeconds: 3600 };
  }

  async fetchIdentity(): Promise<PatreonIdentity> {
    return this.identity;
  }
}
```

- [ ] **Step 6: Write the failing JSON:API parsing test**

`apps/api/test/patreon-client.e2e-spec.ts`:

```ts
import { ConfigService } from '../src/config/config.module';
import { HttpPatreonClient } from '../src/patreon/http-patreon.client';

describe('HttpPatreonClient', () => {
  let client: HttpPatreonClient;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PATREON_CLIENT_ID = 'client-id';
    process.env.PATREON_CLIENT_SECRET = 'client-secret';
    process.env.PATREON_REDIRECT_URI = 'http://localhost:3000/auth/patreon/callback';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    client = new HttpPatreonClient(new ConfigService());
  });

  it('builds an authorization URL carrying state and the S256 challenge', () => {
    const url = new URL(
      client.buildAuthorizationUrl({ state: 'state-123', codeChallenge: 'challenge-abc' }),
    );
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('flattens the JSON:API identity payload into memberships', async () => {
    const payload = {
      data: {
        id: 'user-9',
        attributes: { full_name: 'Ada', email: 'ada@example.com', image_url: 'https://img' },
        relationships: { memberships: { data: [{ id: 'member-1' }] } },
      },
      included: [
        {
          id: 'member-1',
          type: 'member',
          attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 500 },
          relationships: {
            campaign: { data: { id: 'campaign-7' } },
            currently_entitled_tiers: { data: [{ id: 'tier-3' }] },
          },
        },
        { id: 'other', type: 'campaign' },
      ],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const identity = await client.fetchIdentity('token');

    expect(identity.patreonUserId).toBe('user-9');
    expect(identity.memberships).toEqual([
      {
        campaignId: 'campaign-7',
        patreonTierIds: ['tier-3'],
        amountCents: 500,
        isActivePatron: true,
      },
    ]);
  });

  it('throws without leaking the response body when Patreon rejects the exchange', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(
      'Patreon token exchange failed',
    );
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && pnpm test -- patreon-client`
Expected: PASS (3 tests). Write Steps 1-5 first if you are following strict TDD ordering — run this test before Step 3's implementation exists to see it fail on the missing module.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): patreon oauth client behind an interface with a test fake"
```

---

## Task 4: Redis session store

**Files:**

- Create: `apps/api/src/session/session.service.ts`, `apps/api/src/session/session.module.ts`
- Test: `apps/api/test/session.int-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- Consumes: `RedisService.raw`, `ConfigService`.
- Produces: `SessionService` with `create(userId: string): Promise<string>` (returns the raw token), `resolve(token: string): Promise<string | null>` (returns userId), `destroy(token: string): Promise<void>`, `destroyAllForUser(userId: string): Promise<void>`. `SessionModule` is `@Global()` and exports `SessionService`.

- [ ] **Step 1: Write the failing session test**

`apps/api/test/session.int-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { ConfigModule } from '../src/config/config.module';
import { RedisModule } from '../src/redis/redis.module';
import { SessionModule } from '../src/session/session.module';
import { SessionService } from '../src/session/session.service';

describe('SessionService (integration)', () => {
  let redis: StartedRedisContainer;
  let sessions: SessionService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.PATREON_CLIENT_ID = 'id';
    process.env.PATREON_CLIENT_SECRET = 'secret';
    process.env.PATREON_REDIRECT_URI = 'http://localhost:3000/auth/patreon/callback';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule, SessionModule],
    }).compile();
    await moduleRef.init();
    sessions = moduleRef.get(SessionService);
    close = () => moduleRef.close();
  }, 120_000);

  afterAll(async () => {
    await close();
    await redis.stop();
  });

  it('resolves a freshly created session to its user', async () => {
    const token = await sessions.create('user-1');
    expect(await sessions.resolve(token)).toBe('user-1');
  });

  it('returns null for an unknown token', async () => {
    expect(await sessions.resolve('not-a-real-token')).toBeNull();
  });

  it('stops resolving a destroyed session', async () => {
    const token = await sessions.create('user-2');
    await sessions.destroy(token);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('issues a distinct token per session', async () => {
    expect(await sessions.create('user-3')).not.toBe(await sessions.create('user-3'));
  });

  it('never stores the raw token in redis', async () => {
    const token = await sessions.create('user-4');
    const keys = await sessions.debugKeys();
    expect(keys.join(' ')).not.toContain(token);
  });

  it('drops every session for a user on demand', async () => {
    const first = await sessions.create('user-5');
    const second = await sessions.create('user-5');
    await sessions.destroyAllForUser('user-5');
    expect(await sessions.resolve(first)).toBeNull();
    expect(await sessions.resolve(second)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- session`
Expected: FAIL — cannot find module `../src/session/session.module`.

- [ ] **Step 3: Implement `SessionService`**

`apps/api/src/session/session.service.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { RedisService } from '../redis/redis.service';

const TOKEN_BYTES = 32;
const SESSION_PREFIX = 'sess:';
const USER_SESSIONS_PREFIX = 'sess-user:';

@Injectable()
export class SessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const ttl = this.config.get('SESSION_TTL_SECONDS');
    const key = this.keyFor(token);
    // The user index lets logout-everywhere work without scanning the keyspace.
    await this.redis
      .raw()
      .multi()
      .set(key, userId, 'EX', ttl)
      .sadd(`${USER_SESSIONS_PREFIX}${userId}`, key)
      .expire(`${USER_SESSIONS_PREFIX}${userId}`, ttl)
      .exec();
    return token;
  }

  async resolve(token: string): Promise<string | null> {
    return this.redis.raw().get(this.keyFor(token));
  }

  async destroy(token: string): Promise<void> {
    const key = this.keyFor(token);
    const userId = await this.redis.raw().get(key);
    const pipeline = this.redis.raw().multi().del(key);
    if (userId) pipeline.srem(`${USER_SESSIONS_PREFIX}${userId}`, key);
    await pipeline.exec();
  }

  async destroyAllForUser(userId: string): Promise<void> {
    const indexKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const keys = await this.redis.raw().smembers(indexKey);
    if (keys.length > 0) await this.redis.raw().del(...keys);
    await this.redis.raw().del(indexKey);
  }

  /** Test seam: lets a test assert the raw token never reaches Redis. */
  async debugKeys(): Promise<string[]> {
    return this.redis.raw().keys(`${SESSION_PREFIX}*`);
  }

  /**
   * Sessions are stored under a SHA-256 of the token, never the token itself. A dump of Redis
   * therefore yields no usable credentials, and lookup is an O(1) keyed GET — so there is no
   * secret-dependent comparison for a timing attack to target.
   */
  private keyFor(token: string): string {
    return `${SESSION_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
  }
}
```

`apps/api/src/session/session.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { SessionService } from './session.service';

@Global()
@Module({ providers: [SessionService], exports: [SessionService] })
export class SessionModule {}
```

- [ ] **Step 4: Expose the raw ioredis client as a method**

`RedisService` currently exposes `get raw(): Redis`. The session service calls `this.redis.raw()`. Change the getter to a method so the call sites above compile:

```ts
  raw(): Redis {
    return this.client;
  }
```

Update any existing usage accordingly (there is none outside tests as of Plan 01).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test -- session`
Expected: PASS (6 tests).

- [ ] **Step 6: Register `SessionModule` and commit**

Add `SessionModule` to `AppModule`'s `imports`, then:

```bash
git add -A
git commit -m "feat(api): redis-backed session store keyed by hashed tokens"
```

---

## Task 5: OAuth state & PKCE lifecycle

**Files:**

- Create: `apps/api/src/auth/oauth-state.service.ts`
- Test: `apps/api/test/oauth-state.int-spec.ts`

**Interfaces:**

- Consumes: `RedisService.raw()`.
- Produces: `OAuthStateService` with `start(): Promise<{ state: string; codeChallenge: string }>` and `consume(state: string): Promise<string | null>` (returns the code verifier, single-use).

- [ ] **Step 1: Write the failing test**

`apps/api/test/oauth-state.int-spec.ts`:

```ts
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { ConfigModule } from '../src/config/config.module';
import { RedisModule } from '../src/redis/redis.module';
import { OAuthStateService } from '../src/auth/oauth-state.service';

describe('OAuthStateService (integration)', () => {
  let redis: StartedRedisContainer;
  let states: OAuthStateService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.PATREON_CLIENT_ID = 'id';
    process.env.PATREON_CLIENT_SECRET = 'secret';
    process.env.PATREON_REDIRECT_URI = 'http://localhost:3000/auth/patreon/callback';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule],
      providers: [OAuthStateService],
    }).compile();
    await moduleRef.init();
    states = moduleRef.get(OAuthStateService);
    close = () => moduleRef.close();
  }, 120_000);

  afterAll(async () => {
    await close();
    await redis.stop();
  });

  it('derives the challenge as the S256 hash of the stored verifier', async () => {
    const { state, codeChallenge } = await states.start();
    const verifier = await states.consume(state);
    expect(verifier).not.toBeNull();
    const expected = createHash('sha256').update(verifier as string).digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('refuses to replay a state', async () => {
    const { state } = await states.start();
    expect(await states.consume(state)).not.toBeNull();
    expect(await states.consume(state)).toBeNull();
  });

  it('returns null for a state it never issued', async () => {
    expect(await states.consume('forged-state')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- oauth-state`
Expected: FAIL — cannot find module `../src/auth/oauth-state.service`.

- [ ] **Step 3: Implement `OAuthStateService`**

`apps/api/src/auth/oauth-state.service.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const STATE_PREFIX = 'oauth-state:';
// The window between the redirect to Patreon and the callback. Short, because a pending state
// is an unauthenticated write.
const STATE_TTL_SECONDS = 600;

@Injectable()
export class OAuthStateService {
  constructor(private readonly redis: RedisService) {}

  async start(): Promise<{ state: string; codeChallenge: string }> {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    await this.redis
      .raw()
      .set(`${STATE_PREFIX}${state}`, codeVerifier, 'EX', STATE_TTL_SECONDS);
    return {
      state,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    };
  }

  /**
   * GETDEL makes consumption atomic: a replayed callback finds nothing, so a captured `code`
   * cannot be exchanged twice even under concurrent requests.
   */
  async consume(state: string): Promise<string | null> {
    return this.redis.raw().getdel(`${STATE_PREFIX}${state}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test -- oauth-state`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): single-use oauth state with pkce verifier in redis"
```

---

## Task 6: Login redirect & callback

**Files:**

- Create: `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/src/main.ts` (cookie parser, validation pipe)
- Modify: `apps/api/package.json` (add `cookie-parser`, `class-validator`, `class-transformer`)
- Test: `apps/api/test/auth-flow.int-spec.ts`

**Interfaces:**

- Consumes: `OAuthStateService`, `PATREON_CLIENT`, `PrismaService`, `EncryptionService`, `SessionService`.
- Produces: `AuthService.completeLogin(code: string, state: string): Promise<string>` returning a session token; `GET /auth/patreon/login` → 302; `GET /auth/patreon/callback?code&state` → 302 to `WEB_ORIGIN` with the session cookie set.

- [ ] **Step 1: Add dependencies**

Add to `apps/api/package.json` `dependencies`: `"cookie-parser": "1.4.7"`, `"class-validator": "0.14.1"`, `"class-transformer": "0.5.1"`. Add to `devDependencies`: `"@types/cookie-parser": "1.4.7"`. Then `pnpm install`.

- [ ] **Step 2: Write the failing auth-flow test**

`apps/api/test/auth-flow.int-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../src/app.module';
import { PATREON_CLIENT } from '../src/patreon/patreon.client';
import { startDatabase } from './support/database';
import { FakePatreonClient } from './support/fake-patreon.client';

describe('Patreon auth flow (integration)', () => {
  let app: INestApplication;
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let prisma: PrismaClient;
  const patreon = new FakePatreonClient();

  beforeAll(async () => {
    pg = await startDatabase();
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.PATREON_CLIENT_ID = 'client-id';
    process.env.PATREON_CLIENT_SECRET = 'client-secret';
    process.env.PATREON_REDIRECT_URI = 'http://localhost:3000/auth/patreon/callback';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PATREON_CLIENT)
      .useValue(patreon)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
  }, 240_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
    await pg.stop();
    await redis.stop();
  });

  async function startLogin(): Promise<string> {
    const res = await request(app.getHttpServer()).get('/auth/patreon/login').expect(302);
    return new URL(res.headers.location).searchParams.get('state') as string;
  }

  it('redirects to Patreon with a state parameter', async () => {
    const res = await request(app.getHttpServer()).get('/auth/patreon/login').expect(302);
    expect(res.headers.location).toContain('state=');
    expect(res.headers.location).toContain('code_challenge=');
  });

  it('creates the user and a session cookie on a valid callback', async () => {
    const state = await startLogin();
    const res = await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toContain('pp_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const user = await prisma.user.findUnique({ where: { patreonUserId: 'patreon-user-1' } });
    expect(user?.fullName).toBe('Ada Lovelace');
  });

  it('passes the PKCE verifier matching the issued challenge to the exchange', async () => {
    patreon.exchangeCalls = [];
    const state = await startLogin();
    await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    expect(patreon.exchangeCalls).toHaveLength(1);
    expect(patreon.exchangeCalls[0].codeVerifier).toMatch(/^[\w-]{40,}$/);
  });

  it('rejects a forged state', async () => {
    await request(app.getHttpServer())
      .get('/auth/patreon/callback?code=auth-code&state=forged')
      .expect(401);
  });

  it('rejects a replayed state', async () => {
    const state = await startLogin();
    await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(401);
  });

  it('stores patreon tokens encrypted, never in plaintext', async () => {
    const state = await startLogin();
    await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    const user = await prisma.user.findUnique({ where: { patreonUserId: 'patreon-user-1' } });
    expect(user?.accessTokenEncrypted).not.toBe('access-token');
    expect(user?.accessTokenEncrypted).toContain('v1:');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- auth-flow`
Expected: FAIL — 404 on `/auth/patreon/login` (routes not implemented).

- [ ] **Step 4: Implement `AuthService`**

`apps/api/src/auth/auth.service.ts`:

```ts
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonIdentity } from '../patreon/patreon.types';
import { SessionService } from '../session/session.service';
import { OAuthStateService } from './oauth-state.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly states: OAuthStateService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly sessions: SessionService,
  ) {}

  async buildLoginUrl(): Promise<string> {
    const { state, codeChallenge } = await this.states.start();
    return this.patreon.buildAuthorizationUrl({ state, codeChallenge });
  }

  async completeLogin(code: string, state: string): Promise<string> {
    const codeVerifier = await this.states.consume(state);
    if (!codeVerifier) {
      // Covers a forged state, an expired one, and a replay — all indistinguishable to the
      // caller by design, so the response cannot be used to probe which.
      throw new UnauthorizedException('Invalid authentication request');
    }

    const tokens = await this.patreon.exchangeCode(code, codeVerifier);
    const identity = await this.patreon.fetchIdentity(tokens.accessToken);

    const user = await this.prisma.user.upsert({
      where: { patreonUserId: identity.patreonUserId },
      create: {
        patreonUserId: identity.patreonUserId,
        fullName: identity.fullName,
        email: identity.email,
        avatarUrl: identity.avatarUrl,
        accessTokenEncrypted: this.encryption.encrypt(tokens.accessToken),
        refreshTokenEncrypted: this.encryption.encrypt(tokens.refreshToken),
        tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      },
      update: {
        fullName: identity.fullName,
        email: identity.email,
        avatarUrl: identity.avatarUrl,
        accessTokenEncrypted: this.encryption.encrypt(tokens.accessToken),
        refreshTokenEncrypted: this.encryption.encrypt(tokens.refreshToken),
        tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      },
    });

    await this.syncMemberships(user.id, identity);

    // Rotation on login: a session is always freshly minted, so a token captured before login
    // is never the token that ends up authenticated.
    return this.sessions.create(user.id);
  }

  /**
   * Only campaigns already claimed as Creators can produce a Membership row. Claiming arrives
   * in Plan 03; until then an unclaimed campaign is skipped rather than half-created.
   */
  private async syncMemberships(userId: string, identity: PatreonIdentity): Promise<void> {
    for (const membership of identity.memberships) {
      const creator = await this.prisma.creator.findUnique({
        where: { patreonCampaignId: membership.campaignId },
      });
      if (!creator) continue;

      const tier = membership.patreonTierIds[0]
        ? await this.prisma.tier.findUnique({
            where: {
              creatorId_patreonTierId: {
                creatorId: creator.id,
                patreonTierId: membership.patreonTierIds[0],
              },
            },
          })
        : null;

      await this.prisma.membership.upsert({
        where: { userId_creatorId: { userId, creatorId: creator.id } },
        create: {
          userId,
          creatorId: creator.id,
          currentTierId: tier?.id ?? null,
          amountCents: membership.amountCents,
          isActivePatron: membership.isActivePatron,
          lastSyncedAt: new Date(),
        },
        update: {
          currentTierId: tier?.id ?? null,
          amountCents: membership.amountCents,
          isActivePatron: membership.isActivePatron,
          lastSyncedAt: new Date(),
        },
      });
    }
  }
}
```

- [ ] **Step 5: Implement the controller**

`apps/api/src/auth/auth.controller.ts`:

```ts
import { Controller, Get, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.module';
import { SessionService } from '../session/session.service';
import { AuthService } from './auth.service';

export const SESSION_COOKIE = 'pp_session';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Get('auth/patreon/login')
  async login(@Res() res: Response): Promise<void> {
    res.redirect(await this.auth.buildLoginUrl());
  }

  @Get('auth/patreon/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !state) throw new UnauthorizedException('Invalid authentication request');
    const token = await this.auth.completeLogin(code, state);
    res.cookie(SESSION_COOKIE, token, this.cookieOptions());
    res.redirect(this.config.get('WEB_ORIGIN'));
  }

  @Get('auth/logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    res.status(204).send();
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      // Lax rather than Strict: the OAuth callback is a top-level cross-site GET navigation,
      // which Strict would strip the cookie from.
      sameSite: 'lax' as const,
      secure: this.config.get('NODE_ENV') === 'production',
      path: '/',
      maxAge: this.config.get('SESSION_TTL_SECONDS') * 1000,
    };
  }
}
```

`apps/api/src/auth/auth.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthStateService } from './oauth-state.service';

@Module({ controllers: [AuthController], providers: [AuthService, OAuthStateService] })
export class AuthModule {}
```

Register `AuthModule` in `AppModule`'s `imports`.

- [ ] **Step 6: Wire cookie parsing and validation into `main.ts`**

In `apps/api/src/main.ts`, after `NestFactory.create` and before `setGlobalPrefix`:

```ts
import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
// ...
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
```

Note the auth routes live at the root, so add them to the prefix exclusion list:

```ts
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz', 'auth/patreon/login', 'auth/patreon/callback', 'auth/logout'],
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test -- auth-flow`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): patreon oauth login and callback with encrypted token storage"
```

---

## Task 7: Session guard & `/me`

**Files:**

- Create: `apps/api/src/session/session.guard.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Test: `apps/api/test/me.int-spec.ts`

**Interfaces:**

- Consumes: `SessionService`, `PrismaService`.
- Produces: `SessionGuard` (rejects with 401 when no valid session cookie) and `@CurrentUser()` param decorator yielding `{ id: string; patreonUserId: string; fullName: string | null; avatarUrl: string | null }`. `GET /api/v1/me` returns that shape.

- [ ] **Step 1: Write the failing test**

`apps/api/test/me.int-spec.ts` — reuse the bootstrap from `auth-flow.int-spec.ts` (same containers, same `FakePatreonClient` override), then:

```ts
  it('returns 401 without a session cookie', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('returns 401 for a bogus session cookie', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', 'pp_session=not-a-real-token')
      .expect(401);
  });

  it('returns the current user for a valid session', async () => {
    const state = await startLogin();
    const callback = await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    const cookie = (callback.headers['set-cookie'] as unknown as string[])[0];

    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toEqual({
      id: expect.any(String),
      patreonUserId: 'patreon-user-1',
      fullName: 'Ada Lovelace',
      avatarUrl: 'https://example.com/ada.png',
    });
  });

  it('never exposes stored patreon tokens', async () => {
    const state = await startLogin();
    const callback = await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    const cookie = (callback.headers['set-cookie'] as unknown as string[])[0];
    const res = await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie);
    expect(JSON.stringify(res.body)).not.toContain('access-token');
    expect(JSON.stringify(res.body)).not.toContain('Encrypted');
  });

  it('stops accepting the cookie after logout', async () => {
    const state = await startLogin();
    const callback = await request(app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    const cookie = (callback.headers['set-cookie'] as unknown as string[])[0];

    await request(app.getHttpServer()).get('/auth/logout').set('Cookie', cookie).expect(204);
    await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie).expect(401);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- me`
Expected: FAIL — 404 on `/api/v1/me`.

- [ ] **Step 3: Implement the guard and decorator**

`apps/api/src/session/session.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';

export const SESSION_COOKIE = 'pp_session';

export interface CurrentUserPayload {
  id: string;
  patreonUserId: string;
  fullName: string | null;
  avatarUrl: string | null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException();

    const userId = await this.sessions.resolve(token);
    if (!userId) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      // Explicit select: the encrypted token columns must never ride along into a handler,
      // where they could be serialized into a response by accident.
      select: { id: true, patreonUserId: true, fullName: true, avatarUrl: true },
    });
    if (!user) throw new UnauthorizedException();

    (request as Request & { currentUser: CurrentUserPayload }).currentUser = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload =>
    context.switchToHttp().getRequest<Request & { currentUser: CurrentUserPayload }>().currentUser,
);
```

- [ ] **Step 4: Add the `/me` route**

In `apps/api/src/auth/auth.controller.ts`, import the guard and decorator and add:

```ts
  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: CurrentUserPayload): CurrentUserPayload {
    return user;
  }
```

`me` is not in the prefix exclusion list, so it is served at `/api/v1/me` per design §8. Replace the local `SESSION_COOKIE` constant in the controller with an import from `session.guard.ts` so there is a single definition.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test -- me`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): session guard and /me endpoint"
```

---

## Task 8: CSRF protection for state-changing requests

**Files:**

- Create: `apps/api/src/csrf/csrf.middleware.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/csrf.int-spec.ts`

**Interfaces:**

- Consumes: nothing beyond the request/response.
- Produces: `CsrfMiddleware` implementing double-submit: issues a `pp_csrf` cookie on safe requests, and requires the `x-csrf-token` header to match it on `POST`/`PUT`/`PATCH`/`DELETE`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/csrf.int-spec.ts` — bootstrap as in `auth-flow.int-spec.ts`, then:

```ts
  it('issues a csrf cookie on a safe request', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.join(';')).toContain('pp_csrf=');
  });

  it('rejects a state-changing request with no csrf token', async () => {
    await request(app.getHttpServer()).post('/api/v1/anything').expect(403);
  });

  it('rejects a state-changing request whose header does not match the cookie', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', 'pp_csrf=aaa')
      .set('x-csrf-token', 'bbb')
      .expect(403);
  });

  it('allows a state-changing request whose header matches the cookie', async () => {
    // 404 rather than 403: CSRF passed and routing took over, which is the assertion.
    await request(app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', 'pp_csrf=matching-token')
      .set('x-csrf-token', 'matching-token')
      .expect(404);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- csrf`
Expected: FAIL — the POST returns 404, not 403 (no CSRF enforcement yet).

- [ ] **Step 3: Implement the middleware**

`apps/api/src/csrf/csrf.middleware.ts`:

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const CSRF_COOKIE = 'pp_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      // Readable by JS on purpose: the SPA has to echo it back in the header. Security comes
      // from same-origin policy preventing another site from reading it, not from secrecy.
      if (!req.cookies?.[CSRF_COOKIE]) {
        res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
          httpOnly: false,
          sameSite: 'lax',
          path: '/',
        });
      }
      return next();
    }

    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.header(CSRF_HEADER);
    if (!cookieToken || !headerToken || !this.matches(cookieToken, headerToken)) {
      throw new ForbiddenException('Invalid CSRF token');
    }
    next();
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    // timingSafeEqual throws on length mismatch, so guard before comparing.
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
```

- [ ] **Step 4: Register the middleware**

In `apps/api/src/app.module.ts`, make `AppModule` implement `NestModule`:

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CsrfMiddleware } from './csrf/csrf.middleware';

export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
```

The OAuth callback is a `GET`, so it is unaffected.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && pnpm test -- csrf`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full suite and formatting**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
```

Expected: all green. Prisma models mean `pnpm --filter @app/api prisma:generate` must run before typecheck on a fresh checkout — confirm CI already does this (it does, from Plan 01 Task 6).

- [ ] **Step 7 (optional): Manual end-to-end check against real Patreon**

Only if you have a Patreon client ID/secret. Register `http://localhost:3000/auth/patreon/callback` as the redirect URI in the Patreon app settings, put the real values in `.env`, start the API, and visit `http://localhost:3000/auth/patreon/login`. Expected: Patreon consent screen → redirect back → `pp_session` cookie set → `GET /api/v1/me` returns your Patreon profile.

**This is the step that validates the PKCE assumption.** Patreon is a confidential client here (the exchange is server-side with `client_secret`), so `state` is what actually provides CSRF protection; `code_challenge` is sent because design §9 requires PKCE, and is harmless if Patreon ignores it. If the real exchange rejects the request because of `code_verifier`, drop those two parameters from `HttpPatreonClient` and record the deviation — do not weaken `state`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): double-submit csrf protection for state-changing requests"
```

---

## Self-Review

**Spec coverage (design §4 Authentication + §9 Security, the parts Plan 02 targets):**

- OAuth2 authorization-code + PKCE + `state` → Tasks 5, 6. ✅
- Server-side exchange over HTTPS → Task 3 (`HttpPatreonClient.exchangeCode`). ✅
- Identity endpoint with memberships + tiers includes → Task 3. ✅
- Upsert `User`, tokens encrypted at rest → Tasks 1, 2, 6. ✅
- Upsert `Membership` rows → Task 6 (`syncMemberships`), limited to claimed creators. ✅
- Server-side session in Redis, httpOnly/Secure/SameSite cookie → Tasks 4, 6. ✅
- **Rotate session on login** → Task 6 (a new session is minted every callback). ✅
- Invalidation on logout → Tasks 6, 7. ✅
- CSRF tokens on state-changing requests → Task 8. ✅
- Input validation via `ValidationPipe` → Task 6 Step 6. ✅
- Generic errors, no user enumeration → Task 6 (one `UnauthorizedException` for forged/expired/replayed state). ✅
- Secrets never logged → Task 3 (status-only logging). ✅
- Login-time re-sync fallback → Task 6. ✅
- Webhooks, creator claiming, access guards → **deferred to Plans 03-04** (stated in Scope). ✅

**Placeholder scan:** no TBD/TODO; every code step contains compilable content. Task 7 and Task 8 tests say "bootstrap as in `auth-flow.int-spec.ts`" — that bootstrap is written out in full in Task 6 Step 2, which is the file being copied. ✅

**Type consistency:** `PatreonClient` method names match between `patreon.client.ts` (Task 3), `HttpPatreonClient` (Task 3), `FakePatreonClient` (Task 3), and `AuthService` (Task 6). `SessionService.create/resolve/destroy/destroyAllForUser` are defined in Task 4 and used identically in Tasks 6 and 7. `SESSION_COOKIE` is defined once in `session.guard.ts` and imported by the controller (Task 7 Step 4 removes the duplicate introduced in Task 6). `RedisService.raw` changes from getter to method in Task 4 Step 4, which every later call site assumes. ✅

**Known risk carried into implementation:** Patreon's support for PKCE on the token endpoint is unverified — Task 8 Step 7 is the checkpoint, with a documented fallback that preserves `state`.
