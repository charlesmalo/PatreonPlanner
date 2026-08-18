import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RateLimited } from '../limits/rate-limit.guard';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { SESSION_COOKIE } from '../session/session.cookie';
import { SessionService } from '../session/session.service';
import { DiscoveryService } from './discovery.service';
import { SearchCreatorsQuery } from './dto/search-creators.query';

@Controller('creators')
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Open to signed-out readers: boards are public, and requiring a session to find one would mean
   * knowing the slug before you could look it up. Metered as a search, like the catalogue is.
   */
  @Get()
  @RateLimited('search')
  async search(@Query() query: SearchCreatorsQuery, @Req() req: Request) {
    // Read directly rather than through SessionGuard, which would reject the signed-out half of
    // this endpoint's audience.
    const token = req.cookies?.[SESSION_COOKIE];
    const userId = token ? await this.sessions.resolve(token) : null;
    return this.discovery.search(query.q ?? '', userId ?? undefined);
  }

  @Post(':slug/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  favorite(@Param('slug') slug: string, @CurrentUser() user: CurrentUserPayload) {
    return this.discovery.favorite(slug, user.id);
  }

  @Delete(':slug/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  unfavorite(@Param('slug') slug: string, @CurrentUser() user: CurrentUserPayload) {
    return this.discovery.unfavorite(slug, user.id);
  }
}
