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
