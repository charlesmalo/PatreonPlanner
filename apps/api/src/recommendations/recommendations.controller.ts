import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Viewer } from '../access/capability';
import {
  CreatorAccessGuard,
  CurrentCreator,
  CurrentViewer,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { ChangeStatusDto } from '../moderation/dto/change-status.dto';
import { ModerationActionsService } from '../moderation/moderation-actions.service';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { ListRecommendationsQuery } from './dto/list-recommendations.query';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { RecommendationsService } from './recommendations.service';

// :slug so CreatorAccessGuard resolves the tenant the same way it does everywhere else.
@Controller('creators/:slug/recommendations')
export class RecommendationsController {
  constructor(
    private readonly recommendations: RecommendationsService,
    private readonly moderationActions: ModerationActionsService,
  ) {}

  @Get()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  list(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListRecommendationsQuery,
  ) {
    return this.recommendations.list(creator, query.cursor, query.limit, viewer);
  }

  @Post()
  @RequireCapability('SUBMIT')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async submit(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: SubmitRecommendationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.recommendations.submit(creator.id, user.id, dto);
    // 201 only when something was actually created; a de-duplicated resubmit answers 200, since
    // "Created" would be untrue and clients key retry behaviour off it.
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Post(':id/status')
  // The addressed resource is the recommendation, which is updated in place — 201 would promise
  // a new resource at a new location, and there is none.
  @HttpCode(HttpStatus.OK)
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  changeStatus(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStatusDto,
  ) {
    return this.moderationActions.changeStatus(creator.id, id, user.id, dto.status, dto.note);
  }

  @Post(':id/upvote')
  @RequireCapability('UPVOTE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  upvote(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recommendations.toggleUpvote(creator.id, id, user.id);
  }
}
