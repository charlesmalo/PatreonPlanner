import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { SetNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * VIEW: a preference about a board's news is only meaningful to somebody entitled to read it, and
 * the guard answers a board they may not see with a 404 rather than a 403 — the standing rule, so
 * this endpoint cannot be used to confirm a private board exists.
 */
@Controller('creators/:slug/notification-preferences')
@RequireCapability('VIEW')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  get(@CurrentCreator() creator: ResolvedCreator, @CurrentUser() user: CurrentUserPayload) {
    return this.preferences.get(user.id, creator.id);
  }

  @Put()
  set(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: SetNotificationPreferencesDto,
  ) {
    return this.preferences.set(user.id, creator.id, dto.statuses, dto.themeIds ?? []);
  }
}
