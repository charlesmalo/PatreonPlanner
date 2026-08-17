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
  Post,
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
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { PATRON_VISIBLE_STATUSES } from '../moderation/transitions';
import { MergeThemeDto } from './dto/merge-theme.dto';
import { RenameThemeDto } from './dto/rename-theme.dto';
import { ThemesService, themeSlug } from './themes.service';

// The statuses a count may include. Rejected and deleted entries are gone as far as a reader is
// concerned, and counting them would advertise their existence.
const COUNTED_STATUSES = PATRON_VISIBLE_STATUSES;

@Controller('creators/:slug/themes')
export class ThemesController {
  private readonly logger = new Logger(ThemesController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly themes: ThemesService,
  ) {}

  // VIEW: themes are how a reader narrows the board, so anyone who can read it can list them.
  @Get()
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  async list(@CurrentCreator() creator: ResolvedCreator) {
    const rows = await this.prisma.theme.findMany({
      where: { creatorId: creator.id },
      select: { id: true, name: true, titles: { select: { titleId: true } } },
      orderBy: { name: 'asc' },
    });

    // Counted over *board entries*, not TitleTheme rows. A TitleTheme survives its entry being
    // rejected or deleted, so counting rows advertised "Anime (7)" on a filter that returned
    // three — and leaked how many hidden entries a theme covers.
    const counts = await this.prisma.recommendation.groupBy({
      by: ['titleId'],
      where: { creatorId: creator.id, status: { in: COUNTED_STATUSES }, titleId: { not: null } },
      _count: { _all: true },
    });
    const byTitle = new Map(counts.map((row) => [row.titleId as string, row._count._all]));

    return {
      items: rows.map(({ titles, ...theme }) => ({
        ...theme,
        entryCount: titles.reduce((total, t) => total + (byTitle.get(t.titleId) ?? 0), 0),
      })),
    };
  }

  @Patch(':id')
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async rename(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameThemeDto,
  ) {
    const theme = await this.find(creator.id, id);

    // A theme name is shown on a public board, so it is a user string like any other.
    const verdict = await this.moderation.review(
      { creatorId: creator.id, userId: user.id, type: 'THEME', id: theme.id },
      [dto.name],
    );
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
      // The ThemeSource rows are deliberately untouched: re-seeding matches on those labels, so
      // leaving them alone is what stops the next pass from resurrecting the old name.
      data: { name: dto.name.trim(), slug },
      select: { id: true, name: true },
    });
  }

  // POST rather than PATCH: this is not an edit to the theme in the path, it is that theme
  // ceasing to exist in favour of another one.
  @Post(':id/merge')
  // 200, not Nest's default 201: nothing is created here, and the body is the surviving theme.
  @HttpCode(HttpStatus.OK)
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  async merge(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeThemeDto,
  ) {
    return this.themes.merge(creator.id, id, dto.intoId);
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
