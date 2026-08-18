import { Global, Module } from '@nestjs/common';
import { ModerationActionsService } from './moderation-actions.service';
import { FlagsService } from './flags.service';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';
import { ReviewQueueService } from './review-queue.service';
import { CreatorBlocklistModerator } from './creator-blocklist.moderator';
import { WordlistModerator } from './wordlist-moderator';

@Global()
@Module({
  controllers: [ModerationController],
  providers: [
    WordlistModerator,
    CreatorBlocklistModerator,
    ModerationService,
    ModerationActionsService,
    FlagsService,
    ReviewQueueService,
  ],
  exports: [ModerationService, ModerationActionsService, FlagsService],
})
export class ModerationModule {}
