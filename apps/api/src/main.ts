import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ConfigService } from './config/config.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // Without this, onModuleDestroy never runs outside tests — the Prisma and Redis disconnects
  // would be dead code — and node as PID 1 ignores SIGTERM until Docker escalates to SIGKILL.
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  await app.listen(config.get('PORT'));
}
void bootstrap();
