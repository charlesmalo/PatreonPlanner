import {
  Body,
  Controller,
  Get,
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
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { ListRecommendationsQuery } from './dto/list-recommendations.query';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { RecommendationsService } from './recommendations.service';

// :slug so CreatorAccessGuard resolves the tenant the same way it does everywhere else.
@Controller('creators/:slug/recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  list(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListRecommendationsQuery,
  ) {
    return this.recommendations.list(creator.id, query.cursor, query.limit, viewer.userId);
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
