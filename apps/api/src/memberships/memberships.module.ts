import { Global, Module } from '@nestjs/common';
import { MembershipSyncService } from './membership-sync.service';

@Global()
@Module({ providers: [MembershipSyncService], exports: [MembershipSyncService] })
export class MembershipsModule {}
