# PatreonPlanner Phase 1 — Plan 01: Foundation & Walking Skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a runnable, tested monorepo skeleton — NestJS API + React/Vite/Tailwind SPA, backed by Postgres (pgvector) and Redis via Docker — with health/readiness endpoints, a real test harness, and CI.

**Architecture:** A pnpm workspace monorepo with `apps/api` (NestJS) and `apps/web` (Vite SPA). The API is stateless and 12-factor: all config comes from validated env vars, Postgres access via Prisma, Redis via a thin client. Local infra runs through docker-compose; the same images deploy to PaaS. Integration tests spin up ephemeral Postgres/Redis with Testcontainers.

**Tech Stack:** Node 20, TypeScript 5, NestJS 10, Prisma 5, Postgres 16 (pgvector), Redis 7, `ioredis`, Vite 5 + React 18 + Tailwind 3, Jest + supertest + Testcontainers (API), Vitest + Testing Library (web), pnpm workspaces, GitHub Actions.

## Global Constraints

- Node version floor: **20** (`.nvmrc` = 20; `engines.node >= 20`).
- Package manager: **pnpm** (workspaces); do not use npm/yarn for install.
- TypeScript everywhere; **strict mode on**.
- Backend must be **stateless**: no in-memory session/rate state — Postgres/Redis only.
- **12-factor config**: every setting from env; no hardcoded secrets/URLs. Validated at boot.
- Only **Postgres + Redis** as datastores (no proprietary services).
- **Docker from day one**: every app has a Dockerfile; local infra via docker-compose.
- **TDD**: write the failing test first; commit after each green step.
- All commands run from the repo root `/Users/cyber/workspace/PatreonPlanner` unless stated.

---

## File Structure

```
PatreonPlanner/
├── package.json                 # workspace root (private), scripts, pnpm
├── pnpm-workspace.yaml
├── tsconfig.base.json           # shared strict TS config
├── .prettierrc.json
├── .nvmrc
├── .env.example                 # documents all env vars
├── docker-compose.yml           # postgres(pgvector) + redis for local dev/CI
├── .github/workflows/ci.yml
├── apps/
│   ├── api/                     # NestJS backend
│   │   ├── package.json
│   │   ├── tsconfig.json  tsconfig.build.json  nest-cli.json
│   │   ├── jest-e2e.json
│   │   ├── Dockerfile
│   │   ├── prisma/schema.prisma
│   │   └── src/
│   │       ├── main.ts  app.module.ts
│   │       ├── config/config.schema.ts  config/config.module.ts
│   │       ├── prisma/prisma.service.ts  prisma/prisma.module.ts
│   │       ├── redis/redis.service.ts    redis/redis.module.ts
│   │       └── health/health.controller.ts  health/health.module.ts
│   │   └── test/
│   │       ├── health.e2e-spec.ts
│   │       └── readiness.int-spec.ts
│   └── web/                     # Vite + React + Tailwind SPA
│       ├── package.json  tsconfig.json  vite.config.ts
│       ├── tailwind.config.js  postcss.config.js  index.html
│       ├── Dockerfile  nginx.conf
│       └── src/
│           ├── main.tsx  App.tsx  index.css
│           ├── App.test.tsx  vitest.setup.ts
```

Each file has one responsibility: config = env validation only; prisma/redis services = connection lifecycle only; health = liveness/readiness only.

---

## Task 1: Monorepo scaffold & root tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.prettierrc.json`, `.nvmrc`
- Modify: `.gitignore` (append Node/build ignores)

**Interfaces:**
- Consumes: nothing.
- Produces: a pnpm workspace resolving `apps/*`; `tsconfig.base.json` (strict) that app tsconfigs extend; root scripts `pnpm -r typecheck`, `pnpm format:check`.

- [ ] **Step 1: Create `.nvmrc`**

```
20
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
```

- [ ] **Step 3: Create root `package.json`**

```json
{
  "name": "patreonplanner",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "format": "prettier --write \"**/*.{ts,tsx,json,md,yaml,yml}\"",
    "format:check": "prettier --check \"**/*.{ts,tsx,json,md,yaml,yml}\""
  },
  "devDependencies": {
    "prettier": "3.3.3",
    "typescript": "5.5.4"
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 5: Create `.prettierrc.json`**

```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 6: Append to `.gitignore`**

```
node_modules/
dist/
build/
coverage/
*.tsbuildinfo
.env
```

- [ ] **Step 7: Install root deps and verify format check runs**

Run: `pnpm install`
Then: `pnpm format:check`
Expected: prettier runs and reports "All matched files use Prettier code style!" (or lists files to format — if so, run `pnpm format` then re-run `format:check` until clean).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo and root tooling"
```

---

## Task 2: NestJS API skeleton, validated config & liveness endpoint

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`, `apps/api/jest-e2e.json`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/config/config.schema.ts`, `apps/api/src/config/config.module.ts`
- Create: `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts`
- Test: `apps/api/test/health.e2e-spec.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json` from Task 1.
- Produces:
  - `AppConfig` (Zod-inferred type) with fields `NODE_ENV: 'development'|'test'|'production'`, `PORT: number`, `DATABASE_URL: string`, `REDIS_URL: string`.
  - `ConfigModule` (global) exporting `ConfigService` with `get<K extends keyof AppConfig>(key: K): AppConfig[K]`.
  - `GET /healthz` → `200 { status: 'ok' }` (liveness; no external deps).

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@app/api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "node dist/main.js",
    "start:dev": "nest start --watch",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "jest --config jest-e2e.json --runInBand"
  },
  "dependencies": {
    "@nestjs/common": "10.4.4",
    "@nestjs/core": "10.4.4",
    "@nestjs/platform-express": "10.4.4",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.1",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "@nestjs/cli": "10.4.5",
    "@nestjs/testing": "10.4.4",
    "@types/jest": "29.5.13",
    "@types/node": "20.16.10",
    "@types/supertest": "6.0.2",
    "jest": "29.7.0",
    "supertest": "7.0.0",
    "ts-jest": "29.2.5",
    "typescript": "5.5.4"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`**

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "baseUrl": "./" },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`apps/api/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["test", "dist", "**/*spec.ts"] }
```

`apps/api/nest-cli.json`:
```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src" }
```

- [ ] **Step 3: Create `apps/api/jest-e2e.json`**

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".(e2e-spec|int-spec).ts$",
  "transform": { "^.+\\.ts$": "ts-jest" }
}
```

- [ ] **Step 4: Create the config schema and module**

`apps/api/src/config/config.schema.ts`:
```ts
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export type AppConfig = z.infer<typeof configSchema>;
```

`apps/api/src/config/config.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { AppConfig, configSchema } from './config.schema';

export class ConfigService {
  private readonly values: AppConfig;
  constructor() {
    this.values = configSchema.parse(process.env);
  }
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.values[key];
  }
}

@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
```

- [ ] **Step 5: Write the failing liveness test**

`apps/api/test/health.e2e-spec.ts`:
```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('GET /healthz', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with status ok', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd apps/api && pnpm install && pnpm test`
Expected: FAIL — `Cannot find module '../src/app.module'` (AppModule/health not created yet).

- [ ] **Step 7: Implement health controller/module, app module, and bootstrap**

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`apps/api/src/health/health.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

@Module({ imports: [ConfigModule, HealthModule] })
export class AppModule {}
```

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  await app.listen(config.get('PORT'));
}
void bootstrap();
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd apps/api && pnpm test`
Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): nest skeleton with validated config and /healthz liveness"
```

---

## Task 3: Local infra (docker-compose), Prisma & PrismaService

**Files:**
- Create: `docker-compose.yml`, `.env.example`
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/prisma.module.ts`
- Modify: `apps/api/package.json` (add `@prisma/client`, `prisma`, scripts)

**Interfaces:**
- Consumes: `ConfigService` (Task 2) for `DATABASE_URL`.
- Produces: `PrismaService extends PrismaClient` with `onModuleInit`/`onModuleDestroy` connecting/disconnecting, and a method `ping(): Promise<boolean>` (runs `SELECT 1`). `PrismaModule` (global) exports `PrismaService`.

- [ ] **Step 1: Create `docker-compose.yml`** (Postgres with pgvector + Redis)

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: planner
      POSTGRES_PASSWORD: planner
      POSTGRES_DB: planner
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  pgdata:
```

- [ ] **Step 2: Create `.env.example`**

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://planner:planner@localhost:5432/planner
REDIS_URL=redis://localhost:6379
```

- [ ] **Step 3: Add Prisma deps and scripts to `apps/api/package.json`**

Add to `dependencies`: `"@prisma/client": "5.20.0"`.
Add to `devDependencies`: `"prisma": "5.20.0"`.
Add to `scripts`:
```json
"prisma:generate": "prisma generate",
"prisma:migrate": "prisma migrate dev"
```
Then run: `cd apps/api && pnpm install`

- [ ] **Step 4: Create `apps/api/prisma/schema.prisma`** (minimal; models arrive in later plans)

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}
```

- [ ] **Step 5: Start infra and generate the client**

Run:
```bash
docker compose up -d
cd apps/api && pnpm prisma:generate
```
Expected: containers start; `Generated Prisma Client` printed.

- [ ] **Step 6: Implement `PrismaService` and `PrismaModule`**

`apps/api/src/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
  async ping(): Promise<boolean> {
    await this.$queryRaw`SELECT 1`;
    return true;
  }
}
```

`apps/api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

- [ ] **Step 7: Wire `PrismaModule` into `AppModule`**

Modify `apps/api/src/app.module.ts` imports to include `PrismaModule`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';

@Module({ imports: [ConfigModule, PrismaModule, HealthModule] })
export class AppModule {}
```

- [ ] **Step 8: Verify existing liveness test still passes and app compiles**

Run: `cd apps/api && pnpm typecheck && pnpm test`
Expected: typecheck clean; `GET /healthz` test still PASSES.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): docker-compose infra, prisma datasource and PrismaService"
```

---

## Task 4: Redis service & readiness endpoint (integration-tested with Testcontainers)

**Files:**
- Create: `apps/api/src/redis/redis.service.ts`, `apps/api/src/redis/redis.module.ts`
- Modify: `apps/api/src/health/health.controller.ts` (add `/readyz`), `apps/api/src/health/health.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `RedisModule`)
- Test: `apps/api/test/readiness.int-spec.ts`
- Modify: `apps/api/package.json` (add `ioredis`, `@testcontainers/postgresql`, `@testcontainers/redis`)

**Interfaces:**
- Consumes: `ConfigService` (`REDIS_URL`), `PrismaService.ping()`.
- Produces: `RedisService` wrapping an `ioredis` client with `ping(): Promise<boolean>` (`await client.ping() === 'PONG'`) and lifecycle hooks. `GET /readyz` → `200 { status: 'ready', checks: { db: true, redis: true } }` when both pass, else `503 { status: 'unready', checks: {...} }`.

- [ ] **Step 1: Add deps**

Add to `apps/api/package.json` `dependencies`: `"ioredis": "5.4.1"`.
Add to `devDependencies`: `"@testcontainers/postgresql": "10.13.2"`, `"@testcontainers/redis": "10.13.2"`.
Run: `cd apps/api && pnpm install`

- [ ] **Step 2: Write the failing readiness integration test**

`apps/api/test/readiness.int-spec.ts`:
```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../src/app.module';

describe('GET /readyz (integration)', () => {
  let app: INestApplication;
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pg.stop();
    await redis.stop();
  });

  it('reports ready when db and redis are up', async () => {
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { db: true, redis: true } });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- readiness`
Expected: FAIL — `/readyz` returns 404 (route not implemented). (Containers should start; requires Docker running.)

- [ ] **Step 4: Implement `RedisService` and `RedisModule`**

`apps/api/src/redis/redis.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.module';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;
  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new Redis(this.config.get('REDIS_URL'), { lazyConnect: false });
  }
  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
  get raw(): Redis {
    return this.client;
  }
  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }
}
```

`apps/api/src/redis/redis.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
```

- [ ] **Step 5: Add `/readyz` to the health controller**

Replace `apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(): Promise<{ status: 'ready'; checks: { db: boolean; redis: boolean } }> {
    const [db, redis] = await Promise.all([
      this.prisma.ping().catch(() => false),
      this.redis.ping().catch(() => false),
    ]);
    if (!db || !redis) {
      throw new HttpException(
        { status: 'unready', checks: { db, redis } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ready', checks: { db, redis } };
  }
}
```

Update `apps/api/src/health/health.module.ts` (controller now injects Prisma/Redis, which are global — no import change needed, but ensure modules are registered in AppModule).

- [ ] **Step 6: Register `RedisModule` in `AppModule`**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';

@Module({ imports: [ConfigModule, PrismaModule, RedisModule, HealthModule] })
export class AppModule {}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- readiness`
Expected: PASS. Also run `pnpm test` (all): liveness + readiness green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): redis service and /readyz readiness with testcontainers integration test"
```

---

## Task 5: Web SPA skeleton (Vite + React + Tailwind) with a component test

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`
- Create: `apps/web/tailwind.config.js`, `apps/web/postcss.config.js`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`
- Create: `apps/web/vitest.setup.ts`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: nothing from the API yet.
- Produces: a mounting `App` component rendering a heading `PatreonPlanner`; scripts `pnpm --filter @app/web dev|build|test|typecheck`.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@app/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "6.5.0",
    "@testing-library/react": "16.0.1",
    "@types/react": "18.3.11",
    "@types/react-dom": "18.3.0",
    "@vitejs/plugin-react": "4.3.2",
    "autoprefixer": "10.4.20",
    "jsdom": "25.0.1",
    "postcss": "8.4.47",
    "tailwindcss": "3.4.13",
    "typescript": "5.5.4",
    "vite": "5.4.8",
    "vitest": "2.1.2"
  }
}
```

- [ ] **Step 2: Create config files**

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vitest.setup.ts"]
}
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
```

`apps/web/tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

`apps/web/postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 3: Create app source**

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PatreonPlanner</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`apps/web/src/App.tsx`:
```tsx
export default function App() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <h1 className="text-2xl font-bold">PatreonPlanner</h1>
    </main>
  );
}
```

`apps/web/src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 4: Create the Vitest setup and write the failing component test**

`apps/web/vitest.setup.ts`:
```ts
import '@testing-library/jest-dom';
```

`apps/web/src/App.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the app title', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'PatreonPlanner' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Install and run the test**

Run: `cd apps/web && pnpm install && pnpm test`
Expected: PASS (1 test). (If you write the test before `App.tsx` exists to see it fail first, expect a module-not-found failure; here App is defined in Step 3.)

- [ ] **Step 6: Verify dev build compiles**

Run: `cd apps/web && pnpm build`
Expected: `tsc -b` clean and Vite emits `dist/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): vite+react+tailwind SPA skeleton with component test"
```

---

## Task 6: CI pipeline & production Dockerfiles

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`

**Interfaces:**
- Consumes: root scripts (`pnpm -r typecheck`, `pnpm -r test`) and app build scripts.
- Produces: a CI job that installs, typechecks, tests, and builds both apps with Postgres+Redis services available; deployable images for api and web.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: planner
          POSTGRES_PASSWORD: planner
          POSTGRES_DB: planner
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U planner"
          --health-interval 10s --health-timeout 5s --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    env:
      DATABASE_URL: postgresql://planner:planner@localhost:5432/planner
      REDIS_URL: redis://localhost:6379
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @app/api prisma:generate
      - run: pnpm -r typecheck
      - run: pnpm format:check
      - run: pnpm -r test
      - run: pnpm --filter @app/web build
      - run: pnpm --filter @app/api build
```

- [ ] **Step 2: Create `apps/api/Dockerfile`**

```dockerfile
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @app/api... --frozen-lockfile=false
COPY apps/api apps/api
COPY tsconfig.base.json ./
RUN pnpm --filter @app/api prisma:generate && pnpm --filter @app/api build

FROM node:20-slim AS runtime
RUN corepack enable
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

- [ ] **Step 3: Create `apps/web/Dockerfile` and `nginx.conf`**

`apps/web/Dockerfile`:
```dockerfile
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @app/web... --frozen-lockfile=false
COPY apps/web apps/web
RUN pnpm --filter @app/web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
```

`apps/web/nginx.conf`:
```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  location / {
    try_files $uri /index.html;
  }
}
```

- [ ] **Step 4: Verify both images build locally**

Run:
```bash
docker build -f apps/api/Dockerfile -t patreonplanner-api .
docker build -f apps/web/Dockerfile -t patreonplanner-web .
```
Expected: both images build successfully.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: github actions pipeline and production dockerfiles for api and web"
```

---

## Self-Review

**Spec coverage (against design §2 Architecture & portability — the only part Plan 01 targets):**
- pnpm monorepo, NestJS API, React/Vite/Tailwind SPA → Tasks 1, 2, 5. ✅
- Postgres + pgvector via Prisma → Task 3 (extension enabled in datasource). ✅
- Redis → Task 4. ✅
- 12-factor validated config, stateless → Task 2 (Zod config, no in-memory state). ✅
- Docker from day one (compose + Dockerfiles) → Tasks 3, 6. ✅
- Test harness (Jest + supertest + Testcontainers; Vitest) → Tasks 2, 4, 5. ✅
- CI → Task 6. ✅
- Auth, recommendations, moderation, board, catalog intelligence → **deferred to Plans 02–09** (correctly out of scope here).

**Placeholder scan:** no TBD/TODO; every code step contains real, compilable content. ✅

**Type consistency:** `ConfigService.get<K>()` signature is defined in Task 2 and consumed identically in Task 4. `PrismaService.ping()` (Task 3) and `RedisService.ping()` (Task 4) are the exact names used by `HealthController` in Task 4. `AppModule` import list grows consistently across Tasks 2→3→4. ✅

---

## Notes for the next plan (02 — Patreon Auth)

Plan 02 will add the first Prisma models (`User`, session handling), so it introduces the first `prisma migrate` step and a migrations directory. It depends on `ConfigService` (extended with Patreon OAuth env vars), `PrismaService`, and `RedisService` from this plan.
