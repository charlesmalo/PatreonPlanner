import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Reaction } from './palette';

export interface ReactionCount {
  emote: string;
  count: number;
  /** Whether the reader themselves reacted with it. */
  reacted: boolean;
}

@Injectable()
export class ReactionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Adds a reaction, or takes it back when the same one is sent again.
   *
   * Never touches an ordering. A reaction that could move an entry would be a second voting
   * system with none of the tier weighting that makes the first one meaningful — and one anybody
   * could flood.
   */
  async toggle(
    creator: { id: string; allowReactions: boolean },
    userId: string,
    subject: { recommendationId?: string; noteId?: string },
    emote: Reaction,
  ): Promise<ReactionCount> {
    if (!creator.allowReactions) {
      throw new ForbiddenException('This board does not use reactions');
    }
    const { recommendationId, noteId } = subject;
    if (!recommendationId === !noteId) {
      throw new BadRequestException('React to exactly one thing');
    }

    // Scoped by creator: an id alone says nothing about which board owns it, and a note is
    // reached through the entry it hangs on.
    if (recommendationId) {
      const found = await this.prisma.recommendation.findFirst({
        where: { id: recommendationId, creatorId: creator.id },
        select: { id: true },
      });
      if (!found) throw new NotFoundException();
    } else {
      const found = await this.prisma.creatorNote.findFirst({
        where: { id: noteId, recommendation: { creatorId: creator.id } },
        select: { id: true },
      });
      if (!found) throw new NotFoundException();
    }

    const where = recommendationId
      ? { recommendationId_userId_emote: { recommendationId, userId, emote } }
      : { noteId_userId_emote: { noteId: noteId as string, userId, emote } };

    const existing = await this.prisma.reaction.findUnique({ where, select: { id: true } });
    if (existing) {
      await this.prisma.reaction.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.reaction.create({
        data: { userId, emote, recommendationId: recommendationId ?? null, noteId: noteId ?? null },
      });
    }

    const subjectWhere = recommendationId ? { recommendationId } : { noteId };
    const count = await this.prisma.reaction.count({ where: { ...subjectWhere, emote } });
    return { emote, count, reacted: existing === null };
  }

  /**
   * Counts for a page of entries in one query rather than one per card — twenty entries would
   * otherwise mean twenty round trips.
   */
  async forRecommendations(
    recommendationIds: string[],
    viewerUserId: string | null,
  ): Promise<Map<string, ReactionCount[]>> {
    const byEntry = new Map<string, ReactionCount[]>();
    if (recommendationIds.length === 0) return byEntry;

    const rows = await this.prisma.reaction.groupBy({
      by: ['recommendationId', 'emote'],
      where: { recommendationId: { in: recommendationIds } },
      _count: { _all: true },
    });
    // Which of them are the reader's own. Anonymous matches nothing, which is right.
    const mine = viewerUserId
      ? await this.prisma.reaction.findMany({
          where: { recommendationId: { in: recommendationIds }, userId: viewerUserId },
          select: { recommendationId: true, emote: true },
        })
      : [];
    const own = new Set(mine.map((row) => `${row.recommendationId}:${row.emote}`));

    for (const row of rows) {
      const id = row.recommendationId as string;
      const list = byEntry.get(id) ?? [];
      list.push({
        emote: row.emote,
        count: row._count._all,
        reacted: own.has(`${id}:${row.emote}`),
      });
      byEntry.set(id, list);
    }
    return byEntry;
  }
}
