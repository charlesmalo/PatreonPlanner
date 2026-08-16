import { Injectable } from '@nestjs/common';
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
