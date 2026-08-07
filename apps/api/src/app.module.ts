import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { PatreonModule } from './patreon/patreon.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, CryptoModule, PrismaModule, RedisModule, PatreonModule, HealthModule],
})
export class AppModule {}
