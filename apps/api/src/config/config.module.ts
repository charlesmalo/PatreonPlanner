import { Global, Injectable, Module } from '@nestjs/common';
import { AppConfig, configSchema } from './config.schema';

@Injectable()
export class ConfigService {
  private readonly values: AppConfig;
  constructor() {
    this.values = configSchema.parse(process.env);
  }
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.values[key];
  }
}

@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
