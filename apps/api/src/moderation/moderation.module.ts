import { Global, Module } from '@nestjs/common';
import { ModerationActionsService } from './moderation-actions.service';
import { FlagsService } from './flags.service';
import { ModerationService } from './moderation.service';
import { WordlistModerator } from './wordlist-moderator';

@Global()
@Module({
  providers: [WordlistModerator, ModerationService, ModerationActionsService, FlagsService],
  exports: [ModerationService, ModerationActionsService, FlagsService],
})
export class ModerationModule {}
