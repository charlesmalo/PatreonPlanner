import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AccessModule } from './access/access.module';
import { AuthModule } from './auth/auth.module';
import { AvailabilityModule } from './availability/availability.module';
import { CatalogModule } from './catalog/catalog.module';
import { ConfigModule } from './config/config.module';
import { CreatorsModule } from './creators/creators.module';
import { CryptoModule } from './crypto/crypto.module';
import { CsrfMiddleware } from './csrf/csrf.middleware';
import { CsrfModule } from './csrf/csrf.module';
import { JobsModule } from './jobs/jobs.module';
import { LimitsModule } from './limits/limits.module';
import { ModerationModule } from './moderation/moderation.module';
import { MembershipsModule } from './memberships/memberships.module';
import { PatreonModule } from './patreon/patreon.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionModule } from './session/session.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    AccessModule,
    CryptoModule,
    CsrfModule,
    PrismaModule,
    RedisModule,
    SessionModule,
    PatreonModule,
    MembershipsModule,
    JobsModule,
    LimitsModule,
    ModerationModule,
    AuthModule,
    AvailabilityModule,
    CatalogModule,
    CreatorsModule,
    RecommendationsModule,
    WebhooksModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route: the OAuth callback is a GET and so passes through untouched, while any
    // future state-changing endpoint is covered by default rather than by remembering to opt in.
    // The webhook exemption lives inside the middleware rather than in .exclude(): with
    // forRoutes('*') the path matcher did not exclude it, and a silently ineffective exemption
    // is worse than none.
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
