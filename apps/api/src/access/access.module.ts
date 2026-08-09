import { Global, Module } from '@nestjs/common';
import { CreatorAccessGuard } from './creator-access.guard';

@Global()
@Module({ providers: [CreatorAccessGuard], exports: [CreatorAccessGuard] })
export class AccessModule {}
