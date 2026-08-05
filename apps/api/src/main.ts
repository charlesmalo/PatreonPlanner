import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Design §8: the REST surface is versioned under /api/v1, but the ops probes stay at the root
  // so orchestrator config is not coupled to the API version.
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  // Without this, onModuleDestroy never runs outside tests — the Prisma and Redis disconnects
  // would be dead code — and node as PID 1 ignores SIGTERM until Docker escalates to SIGKILL.
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  await app.listen(config.get('PORT'));
}
void bootstrap();
