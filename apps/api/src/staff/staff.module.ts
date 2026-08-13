import { Module } from '@nestjs/common';
import { StaffController, StaffInviteController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  controllers: [StaffController, StaffInviteController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
