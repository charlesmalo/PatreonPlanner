import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  CurrentViewer,
  ResolvedCreator,
} from '../access/creator-access.guard';
import type { Viewer } from '../access/capability';
import { RequireCapability } from '../access/require-capability.decorator';
import { RequirePermission } from '../access/require-permission.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { ListTicketsQuery } from './dto/list-tickets.query';
import { RaiseTicketDto } from './dto/raise-ticket.dto';
import { ResolveTicketDto } from './dto/resolve-ticket.dto';
import { TicketsService } from './tickets.service';

@Controller('creators/:slug/tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  /**
   * VIEW, not SUBMIT: anyone who can read the board can tell staff something about it. Whether a
   * signed-out reader may is the creator's decision, enforced in the service where the policy
   * lives.
   */
  @Post()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  raise(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Body() dto: RaiseTicketDto,
  ) {
    return this.tickets.raise(creator, viewer.userId, dto.body, dto.subjectId);
  }

  // The same job as working the review queue, done from the same inbox — so the same permission.
  @Get()
  @RequireCapability('MODERATE')
  @RequirePermission('HANDLE_REPORTS')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  list(@CurrentCreator() creator: ResolvedCreator, @Query() query: ListTicketsQuery) {
    return this.tickets.list(creator.id, query.status);
  }

  /**
   * VIEW and no permission, unlike the inbox beside it: the reader who raised a ticket is an
   * ordinary reader of the board, and they are the audience of every TICKET_RESOLVED
   * notification. Which of them may see *this* ticket is decided in the service, because the
   * answer is a union — the inbox permission, or having written it — and a decorator can only
   * demand one thing of everybody.
   *
   * A reader who can no longer see the board does not get here at all: VIEW fails in the guard
   * first, which is right. A lapsed patron of a subscribers-only board has lost the board their
   * message was about.
   */
  @Get(':id')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  findOne(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tickets.findOne(creator, id, viewer);
  }

  @Patch(':id')
  @RequireCapability('MODERATE')
  @RequirePermission('HANDLE_REPORTS')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  resolve(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveTicketDto,
  ) {
    return this.tickets.resolve(creator, id, user.id, dto.resolution, dto.reply);
  }
}
