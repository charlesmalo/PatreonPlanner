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
