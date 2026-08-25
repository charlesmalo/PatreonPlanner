import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { RateLimited } from '../limits/rate-limit.guard';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { ReactDto } from './dto/react.dto';
import { ReactionsService } from './reactions.service';

@Controller('creators/:slug/reactions')
export class ReactionsController {
  constructor(private readonly reactions: ReactionsService) {}

  /**
   * UPVOTE, not VIEW: reacting is participation, and a board that gates upvoting gates this too.
   *
   * One endpoint that toggles, rather than a POST and a DELETE. The client's intent is "this is
   * how I feel about it now", and a toggle cannot disagree with itself the way a pair can when a
   * click is doubled.
   *
   * Metered on the existing write bucket. Reacting to four hundred entries in a minute is
   * precisely what a 60-burst limit is for; a third bucket would be new configuration for a case
   * the current one already covers.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimited('write')
  @RequireCapability('UPVOTE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  toggle(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ReactDto,
  ) {
    return this.reactions.toggle(
      creator,
      user.id,
      { recommendationId: dto.recommendationId, noteId: dto.noteId },
      dto.emote,
    );
  }
}
