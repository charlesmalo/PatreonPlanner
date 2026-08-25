import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
  Patch,
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
import { RequirePermission } from '../access/require-permission.decorator';
import { GroupEntryDto } from './dto/group-entry.dto';
import { RankEntryDto } from './dto/rank-entry.dto';
import { GroupingService } from './grouping.service';
import { ChangeStatusDto } from '../moderation/dto/change-status.dto';
import { CreateFlagDto } from '../moderation/dto/create-flag.dto';
import { FlagsService } from '../moderation/flags.service';
import { ModerationActionsService } from '../moderation/moderation-actions.service';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { ListRecommendationsQuery, SimilarQuery } from './dto/list-recommendations.query';
import { RateLimited } from '../limits/rate-limit.guard';
import { SearchService } from './search.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { SubmissionsService } from './submissions.service';
import { UpvotesService } from './upvotes.service';
import { RecommendationsService } from './recommendations.service';

// :slug so CreatorAccessGuard resolves the tenant the same way it does everywhere else.
@Controller('creators/:slug/recommendations')
export class RecommendationsController {
  constructor(
    private readonly recommendations: RecommendationsService,
    private readonly submissions: SubmissionsService,
    private readonly upvotes: UpvotesService,
    private readonly moderationActions: ModerationActionsService,
    private readonly flags: FlagsService,
    private readonly search: SearchService,
    private readonly grouping: GroupingService,
  ) {}

  @Get()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  list(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListRecommendationsQuery,
  ) {
    return this.recommendations.list(
      creator,
      query.cursor,
      query.limit,
      viewer,
      query.theme,
      query.status,
      query.sort,
    );
  }

  /**
   * VIEW, not SUBMIT: this spends no third-party quota and returns only entries the caller could
   * already read on the board. Gating it higher would deny a reader the ability to search a board
   * they are allowed to read, for no benefit.
   *
   * Declared before the `:id` routes so `similar` is not swallowed as an id.
   */
  @Get('similar')
  // The one read with a measured per-request cost, and reachable anonymously on a public board.
  @RateLimited('search')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  similar(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Query() query: SimilarQuery,
  ) {
    return this.search.similar(creator, query.q, viewer);
  }

  /**
   * Declared after `similar` so that literal route is not swallowed as an id, and before the
   * parameterised writes for the same reason in reverse.
   */
  @Get(':id')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  findOne(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recommendations.findOne(creator, id, viewer);
  }

  @Post()
  @RequireCapability('SUBMIT')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async submit(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: SubmitRecommendationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Staff publish their own links immediately; everyone else queues a candidate.
    const result = await this.submissions.submit(
      creator.id,
      user.id,
      dto,
      viewer.staffRole !== null,
    );
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
  @RequirePermission('MOVE_ENTRIES')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  changeStatus(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStatusDto,
  ) {
    return this.moderationActions.changeStatus(creator.id, id, user.id, dto.status, dto.note);
  }

  // VIEW, not SUBMIT: anyone who can read the board can report what is on it. Gating reports
  // behind a pledge tier leaves the cheapest accounts looking at the worst content with no
  // recourse, and a report costs the platform nothing to accept.
  // MODERATE, not ADMINISTER: this is day-to-day curation of what the board shows first, not a
  // change to what the board allows.
  @Post(':id/pick')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability('MODERATE')
  @RequirePermission('MOVE_ENTRIES')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  pick(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    return this.recommendations.setCreatorPick(creator.id, id, true);
  }

  @Delete(':id/pick')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability('MODERATE')
  @RequirePermission('MOVE_ENTRIES')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  unpick(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    return this.recommendations.setCreatorPick(creator.id, id, false);
  }

  /**
   * MOVE_ENTRIES: grouping moves a card *into* another card, which is the same family as moving
   * one between columns and closer than editing its text.
   */
  @Post(':id/group')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability('MODERATE')
  @RequirePermission('MOVE_ENTRIES')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  group(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GroupEntryDto,
  ) {
    return this.grouping.group(creator.id, id, dto.intoId);
  }

  @Patch(':id/rank')
  @RequireCapability('MODERATE')
  @RequirePermission('MOVE_ENTRIES')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  rank(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RankEntryDto,
  ) {
    return this.grouping.rank(creator.id, id, { afterId: dto.afterId, beforeId: dto.beforeId });
  }

  @Delete(':id/group')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability('MODERATE')
  @RequirePermission('MOVE_ENTRIES')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  ungroup(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    return this.grouping.ungroup(creator.id, id);
  }

  @Post(':id/flags')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async raiseFlag(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFlagDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.flags.raise(creator.id, id, user.id, dto.reason, dto.note);
    // 201 only when a flag was actually filed; a repeat answers 200, like a de-duplicated
    // submission does.
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Post(':id/upvote')
  @RequireCapability('UPVOTE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  upvote(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.upvotes.toggleUpvote(creator.id, id, user.id);
  }
}
