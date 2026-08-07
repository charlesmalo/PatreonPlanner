import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
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
    exclude: ['healthz', 'readyz', 'auth/patreon/login', 'auth/patreon/callback', 'auth/logout'],
  });
  // Without this, onModuleDestroy never runs outside tests — the Prisma and Redis disconnects
  // would be dead code — and node as PID 1 ignores SIGTERM until Docker escalates to SIGKILL.
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  await app.listen(config.get('PORT'));
}
void bootstrap();
