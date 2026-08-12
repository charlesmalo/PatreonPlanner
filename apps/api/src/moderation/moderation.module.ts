import { Global, Module } from '@nestjs/common';
import { ModerationActionsService } from './moderation-actions.service';
import { ModerationService } from './moderation.service';
import { WordlistModerator } from './wordlist-moderator';

@Global()
@Module({
  providers: [WordlistModerator, ModerationService, ModerationActionsService],
  exports: [ModerationService, ModerationActionsService],
})
export class ModerationModule {}
