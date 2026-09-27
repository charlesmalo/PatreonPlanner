import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { TokensService } from './tokens.service';

/**
 * Its own controller rather than a route on the recommendations one: a balance belongs to the
 * board, not to any entry, and hanging it off `/recommendations` would put it behind a path
 * segment that has nothing to do with it.
 */
@Controller('creators/:slug/tokens')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  /**
   * This reader's own balance and the rows explaining it.
   *
   * VIEW, not UPVOTE: a lapsed patron who still holds tokens from when they paid must be able to
   * see them. Whether they may *spend* is a separate question the spend endpoint asks.
   *
   * No user id in the path, deliberately — that is the strongest form of "a balance is private":
   * the question cannot be asked rather than being asked and refused.
   */
  @Get()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  mine(@CurrentCreator() creator: ResolvedCreator, @CurrentUser() user: CurrentUserPayload) {
    return this.tokens.balanceFor(creator.id, user.id);
  }
}
