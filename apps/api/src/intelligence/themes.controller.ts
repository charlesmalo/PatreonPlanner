import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
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
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionGuard } from '../session/session.guard';
import { RenameThemeDto } from './dto/rename-theme.dto';
import { themeSlug } from './themes.service';

@Controller('creators/:slug/themes')
export class ThemesController {
  private readonly logger = new Logger(ThemesController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  // VIEW: themes are how a reader narrows the board, so anyone who can read it can list them.
  @Get()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  async list(@CurrentCreator() creator: ResolvedCreator) {
    const rows = await this.prisma.theme.findMany({
      where: { creatorId: creator.id },
      select: { id: true, name: true, _count: { select: { titles: true } } },
      orderBy: { name: 'asc' },
    });
    return { items: rows.map(({ _count, ...theme }) => ({ ...theme, titleCount: _count.titles })) };
  }

  @Patch(':id')
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async rename(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameThemeDto,
  ) {
    const theme = await this.find(creator.id, id);

    // A theme name is shown on a public board, so it is a user string like any other.
    const verdict = await this.moderation.review([dto.name]);
    if (verdict.verdict === 'BLOCK') {
      this.logger.warn(`Blocked theme rename on creator ${creator.id}`);
      throw new BadRequestException('Rejected');
    }

    const slug = themeSlug(dto.name);
    const clash = await this.prisma.theme.findFirst({
      where: { creatorId: creator.id, slug, id: { not: id } },
      select: { id: true },
    });
    // Excluding itself: renaming "Anime" to "ANIME" is a casing change, not a collision.
    if (clash) throw new ConflictException('A theme with that name already exists');

    return this.prisma.theme.update({
      where: { id: theme.id },
      // sourceKey is deliberately untouched: re-seeding matches on it, so leaving it alone is
      // what stops the next enrichment pass from resurrecting the old name.
      data: { name: dto.name.trim(), slug },
      select: { id: true, name: true },
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async remove(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    const theme = await this.find(creator.id, id);
    // Assignments cascade; the titles themselves are global and are not the creator's to delete.
    await this.prisma.theme.delete({ where: { id: theme.id } });
  }

  /** Scoped by creator: a theme id alone says nothing about which board it belongs to. */
  private async find(creatorId: string, id: string) {
    const theme = await this.prisma.theme.findFirst({
      where: { id, creatorId },
      select: { id: true },
    });
    if (!theme) throw new NotFoundException();
    return theme;
  }
}
