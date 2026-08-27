import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { BoardSettingsService } from './board-settings.service';
import { SetBoardSettingsDto } from './dto/board-settings.dto';

/** VIEW: arranging a board is only meaningful to somebody entitled to read it. */
@Controller('creators/:slug/view-settings')
@RequireCapability('VIEW')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class BoardSettingsController {
  constructor(private readonly settings: BoardSettingsService) {}

  @Get()
  get(@CurrentCreator() creator: ResolvedCreator, @CurrentUser() user: CurrentUserPayload) {
    return this.settings.get(user.id, creator.id);
  }

  @Put()
  set(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: SetBoardSettingsDto,
  ) {
    return this.settings.set(user.id, creator.id, dto.collapsed, dto.sorts);
  }
}
