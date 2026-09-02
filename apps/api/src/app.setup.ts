import { Logger, INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { ConfigService } from './config/config.module';

/**
 * The single definition of the request pipeline, shared by main.ts and the integration tests.
 * Duplicating it meant a change here could leave the suites validating a pipeline production no
 * longer had, while still passing.
 */
export function configureApp(app: INestApplication): void {
  app.use(cookieParser());
  app.useGlobalFilters(new PrismaExceptionFilter());

  // Silence here is how a deployment ships a limiter that does nothing: behind a proxy, zero
  // trusted hops means every caller presents the proxy's address and shares one bucket.
  const hops = app.get(ConfigService).get('TRUSTED_PROXY_HOPS');
  if (hops === 0) {
    new Logger('RateLimit').warn(
      'TRUSTED_PROXY_HOPS is 0 — if the API sits behind a proxy, per-IP limiting will treat all traffic as one client',
    );
  }
  // whitelist + forbidNonWhitelisted: unknown properties are rejected rather than silently
  // dropped, so a client cannot smuggle fields past a DTO.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Design §8: the REST surface is versioned under /api/v1, but the ops probes and the OAuth
  // routes stay at the root — the probes so orchestrator config is not coupled to the API
  // version, the OAuth routes because the redirect URI is registered with Patreon and changing
  // it later means editing their app settings.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      'healthz',
      'readyz',
      'auth/patreon/login',
      'auth/patreon/callback',
      'auth/logout',
      // Design §8 places webhooks at the root; the URL is registered with Patreon. The creator
      // id is in the path so the right secret can be selected before the body is trusted.
      'webhooks/patreon/:creatorId',
      // Same reasoning: the URL is registered in Resend's dashboard, so it must not move when
      // the API version does.
      'webhooks/resend',
    ],
  });
}
