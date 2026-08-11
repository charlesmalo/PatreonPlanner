import { Global, Module } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { WordlistModerator } from './wordlist-moderator';

@Global()
@Module({ providers: [WordlistModerator, ModerationService], exports: [ModerationService] })
export class ModerationModule {}
