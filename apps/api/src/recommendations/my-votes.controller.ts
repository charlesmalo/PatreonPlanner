import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { MyVotesService } from './my-votes.service';

/**
 * UPVOTE, not VIEW: this is about votes, and someone who may not vote here has none to see.
 */
@Controller('creators/:slug/my-votes')
@RequireCapability('UPVOTE')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class MyVotesController {
  constructor(private readonly myVotes: MyVotesService) {}

  @Get()
  list(@CurrentCreator() creator: ResolvedCreator, @CurrentUser() user: CurrentUserPayload) {
    return this.myVotes.list(creator.id, user.id);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@CurrentCreator() creator: ResolvedCreator, @CurrentUser() user: CurrentUserPayload) {
    return this.myVotes.refresh(creator, user.id);
  }
}
