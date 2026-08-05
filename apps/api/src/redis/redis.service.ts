import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.module';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new Redis(this.config.get('REDIS_URL'), {
      // Connect explicitly below so boot fails loudly on an unreachable Redis, matching
      // PrismaService.$connect(). Without it, commands can race an unfinished handshake and
      // reject immediately, since the offline queue that would have held them is disabled.
      lazyConnect: true,
      // Defaults queue commands while disconnected and retry 20 times with backoff, so a ping
      // against a dead Redis resolves in ~20s instead of failing. A readiness check needs the
      // opposite: reject now, let the caller report unready.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    // ioredis emits connection errors on the client; without a listener they are silently
    // dropped (it uses silentEmit internally), leaving no trace of why Redis went away.
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
    await this.client.connect();
  }
  async onModuleDestroy(): Promise<void> {
    // May never have been constructed if another module's init hook threw first.
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      // QUIT is itself a command, so it fails when the connection is already gone. Drop the
      // socket instead: shutdown must not throw over a dependency that is merely absent, and
      // this also cancels the reconnect loop that would otherwise keep the process alive.
      this.client.disconnect();
    }
  }
  get raw(): Redis {
    return this.client;
  }
  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }
}
