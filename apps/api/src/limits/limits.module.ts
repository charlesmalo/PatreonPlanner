import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { TokenBucketService } from './token-bucket.service';

@Global()
@Module({
  providers: [RateLimitService, TokenBucketService],
  exports: [RateLimitService, TokenBucketService],
})
export class LimitsModule {}
