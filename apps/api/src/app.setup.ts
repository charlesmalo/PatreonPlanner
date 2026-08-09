import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';

/**
 * The single definition of the request pipeline, shared by main.ts and the integration tests.
 * Duplicating it meant a change here could leave the suites validating a pipeline production no
 * longer had, while still passing.
 */
export function configureApp(app: INestApplication): void {
  app.use(cookieParser());
  app.useGlobalFilters(new PrismaExceptionFilter());
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
      // Design §8 places webhooks at the root; the URL is registered with Patreon.
      'webhooks/patreon',
    ],
  });
}
