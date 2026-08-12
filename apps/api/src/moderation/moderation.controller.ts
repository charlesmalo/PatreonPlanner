import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { RedactDto } from './dto/redact.dto';
import { ResolveFlagDto } from './dto/resolve-flag.dto';
import { ReviewQueueListQuery } from './dto/review-queue.query';
import { ReviewQueueService } from './review-queue.service';

// Everything here is staff-only, so the capability is declared once on the class and the guard
// throws if a handler is ever added without one.
@Controller('creators/:slug')
@RequireCapability('MODERATE')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class ModerationController {
  constructor(private readonly reviewQueue: ReviewQueueService) {}

  @Get('review-queue')
  list(@CurrentCreator() creator: ResolvedCreator, @Query() query: ReviewQueueListQuery) {
    return this.reviewQueue.list(creator.id, query.offset, query.limit);
  }

  @Patch('recommendations/:id')
  redact(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RedactDto,
  ) {
    return this.reviewQueue.redact(
      creator.id,
      id,
      user.id,
      { customTitle: dto.customTitle, description: dto.description },
      dto.note,
    );
  }

  @Patch('flags/:flagId')
  resolveFlag(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('flagId', ParseUUIDPipe) flagId: string,
    @Body() dto: ResolveFlagDto,
  ) {
    return this.reviewQueue.resolveFlag(creator.id, flagId, user.id, dto.status, dto.note);
  }
}
