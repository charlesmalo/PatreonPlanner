import { Global, Module } from '@nestjs/common';
import { AbuseService } from './abuse.service';

@Global()
@Module({ providers: [AbuseService], exports: [AbuseService] })
export class AbuseModule {}
