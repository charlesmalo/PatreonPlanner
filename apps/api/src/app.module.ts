import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { PatreonModule } from './patreon/patreon.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionModule } from './session/session.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    PrismaModule,
    RedisModule,
    SessionModule,
    PatreonModule,
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
