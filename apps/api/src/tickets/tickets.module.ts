import { Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { ModerationModule } from '../moderation/moderation.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [AbuseModule, ModerationModule],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
