import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { CreatorsModule } from './creators/creators.module';
import { CryptoModule } from './crypto/crypto.module';
import { CsrfMiddleware } from './csrf/csrf.middleware';
import { CsrfModule } from './csrf/csrf.module';
import { PatreonModule } from './patreon/patreon.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionModule } from './session/session.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    CsrfModule,
    PrismaModule,
    RedisModule,
    SessionModule,
    PatreonModule,
    AuthModule,
    CreatorsModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route: the OAuth callback is a GET and so passes through untouched, while any
    // future state-changing endpoint is covered by default rather than by remembering to opt in.
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
