import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { RequirePermission } from '../access/require-permission.decorator';
import { SessionGuard } from '../session/session.guard';
import { DecideLinkDto } from './dto/decide-link.dto';
import { LinksService } from './links.service';

/**
 * EDIT_ENTRIES: deciding what link appears on a card is editing what the card says, and it is
 * the decision that puts a URL in front of readers under the creator's name.
 */
@Controller('creators/:slug/links')
@RequireCapability('MODERATE')
@RequirePermission('EDIT_ENTRIES')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Patch(':id')
  decide(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideLinkDto,
  ) {
    return this.links.decide(creator.id, id, { status: dto.status, isPreferred: dto.isPreferred });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  discard(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    return this.links.discard(creator.id, id);
  }
}
