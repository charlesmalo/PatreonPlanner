import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Case-insensitive identity for a theme. Two spellings of "anime" are one theme. */
export function themeSlug(name: string): string {
  return name.trim().toLowerCase();
}

@Injectable()
export class ThemesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Design §5: themes are seeded from TMDB genres and keywords but curated per creator, so the
   * global fact is copied into each creator's namespace the first time a title lands on their
   * board. That is what makes a rename possible without affecting anyone else.
   *
   * Matching is on `sourceKey` — the TMDB label — never the display name. Matching on the name
   * would resurrect a renamed theme the next time another title carried the same genre.
   */
  async seedFor(titleId: string, creatorId: string, labels: string[]): Promise<void> {
    const themeIds: string[] = [];
    for (const label of labels) {
      const id = await this.resolveTheme(creatorId, label);
      if (id) themeIds.push(id);
    }
    if (themeIds.length === 0) return;

    // One statement rather than an upsert per label: a popular film carries dozens of keywords,
    // and a per-row round trip inside a job loop multiplies by every creator holding the title.
    await this.prisma.titleTheme.createMany({
      data: themeIds.map((themeId) => ({ titleId, themeId })),
      skipDuplicates: true,
    });
  }

  /**
   * Folds one theme into another: TMDB seeds "sci-fi" and "science fiction" as two themes, and a
   * creator who wants one name for them has no other way to get there.
   *
   * The label mappings move with the assignments, which is what makes the merge stick — leaving
   * them behind would have the next enrichment pass re-create the theme just folded away.
   */
  async merge(
    creatorId: string,
    id: string,
    intoId: string,
  ): Promise<{ id: string; name: string }> {
    // Not a no-op to wave through: it means the caller confused the two ids, and reporting
    // success would have them believe a merge happened.
    if (id === intoId) throw new BadRequestException('A theme cannot be merged into itself');

    const [source, target] = await Promise.all([
      this.prisma.theme.findFirst({ where: { id, creatorId }, select: { id: true } }),
      this.prisma.theme.findFirst({
        where: { id: intoId, creatorId },
        select: { id: true, name: true },
      }),
    ]);
    // 404 rather than 403 for a theme on another board: the id is not this caller's to know
    // about either way, and the two answers would tell them apart.
    if (!source || !target) throw new NotFoundException();

    await this.prisma.$transaction(async (tx) => {
      const links = await tx.titleTheme.findMany({
        where: { themeId: id },
        select: { titleId: true },
      });
      if (links.length > 0) {
        // skipDuplicates: a title carrying both themes already satisfies the winner.
        await tx.titleTheme.createMany({
          data: links.map((link) => ({ titleId: link.titleId, themeId: intoId })),
          skipDuplicates: true,
        });
      }
      // Before the delete, which would otherwise cascade them away.
      await tx.themeSource.updateMany({ where: { themeId: id }, data: { themeId: intoId } });
      await tx.theme.delete({ where: { id } });
    });

    return target;
  }

  private async resolveTheme(creatorId: string, label: string): Promise<string | null> {
    const sourceKey = themeSlug(label);
    if (sourceKey.length === 0) return null;

    const known = await this.prisma.themeSource.findUnique({
      where: { creatorId_sourceKey: { creatorId, sourceKey } },
      select: { themeId: true },
    });
    // The mapping wins over the name in every case: it is what survives a rename, and what a
    // merge rewrites so the losing theme stays merged.
    if (known) return known.themeId;

    const themeId = await this.themeForNewLabel(creatorId, label, sourceKey);
    if (!themeId) return null;

    // Recorded so the next pass is a point lookup rather than a collision to resolve again.
    await this.prisma.themeSource.upsert({
      where: { creatorId_sourceKey: { creatorId, sourceKey } },
      create: { creatorId, sourceKey, themeId },
      update: {},
    });
    return themeId;
  }

  /**
   * `Theme` is unique on slug per creator, so a creator who renamed "Animation" to "Anime" owns
   * the `anime` slug and the TMDB label "anime" collides on it. Their theme already means this
   * label, so attach to it rather than failing the title: a P2002 escaping here used to abort the
   * title mid-loop, costing every remaining label and every remaining creator their themes —
   * permanently, because `enrichedAt` is stamped regardless.
   */
  private async themeForNewLabel(
    creatorId: string,
    label: string,
    slug: string,
  ): Promise<string | null> {
    try {
      const theme = await this.prisma.theme.create({
        data: { creatorId, name: label.trim(), slug },
        select: { id: true },
      });
      return theme.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.theme.findFirst({
          where: { creatorId, slug },
          select: { id: true },
        });
        return existing?.id ?? null;
      }
      throw error;
    }
  }
}
