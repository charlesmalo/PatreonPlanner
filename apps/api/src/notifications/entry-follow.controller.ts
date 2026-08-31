import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
import { PrismaService } from '../prisma/prisma.service';

/**
 * "Tell me about this one."
 *
 * VIEW rather than anything stronger: following is a wish about news, and the news itself is
 * filtered again by visibility when it is sent — a reader whose pledge lapses stops hearing about
 * a followed entry without anything here having to know.
 */
@Controller('creators/:slug/recommendations/:id/follow')
@RequireCapability('VIEW')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class EntryFollowController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async follow(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    // Scoped by creator: an entry id alone says nothing about which board owns it, and following
    // something on a board this reader cannot see would be a way to confirm it exists.
    const entry = await this.prisma.recommendation.findFirst({
      where: { id, creatorId: creator.id },
      select: { id: true },
    });
    if (!entry) throw new NotFoundException();

    // Following twice is following once.
    await this.prisma.entryFollow.upsert({
      where: { userId_recommendationId: { userId: user.id, recommendationId: id } },
      create: { userId: user.id, recommendationId: id },
      update: {},
    });
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unfollow(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    // deleteMany rather than delete: unfollowing something you do not follow is not an error, and
    // a 404 here would tell an unfollowed reader whether the entry exists.
    await this.prisma.entryFollow.deleteMany({
      where: { userId: user.id, recommendationId: id, recommendation: { creatorId: creator.id } },
    });
  }
}
