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
  UseGuards,
} from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { StaffService } from './staff.service';

// Everything here is owner-only, so the capability is declared once on the class and the guard
// throws if a handler is ever added without one.
@Controller('creators/:slug/staff')
@RequireCapability('MANAGE_STAFF')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentCreator() creator: ResolvedCreator) {
    return this.staff.list(creator.id);
  }

  @Post('invites')
  createInvite(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.staff.createInvite(creator.id, user.id);
  }

  @Delete('invites/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvite(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeInvite(creator.id, id);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.staff.removeMember(creator.id, userId);
  }
}

/**
 * Mounted outside `creators/:slug` on purpose: the invitee does not know which creator the token
 * is for until they redeem it, and making them name it first would render the token less useful
 * than the link it arrived in.
 */
@Controller('staff/invites')
@UseGuards(SessionGuard)
export class StaffInviteController {
  constructor(private readonly staff: StaffService) {}

  @Post('accept')
  accept(@Body() dto: AcceptInviteDto, @CurrentUser() user: CurrentUserPayload) {
    return this.staff.acceptInvite(dto.token, user.id);
  }
}
