import { Injectable } from '@nestjs/common';
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
    for (const label of labels) {
      const sourceKey = themeSlug(label);
      if (sourceKey.length === 0) continue;

      const theme = await this.prisma.theme.upsert({
        where: { creatorId_sourceKey: { creatorId, sourceKey } },
        create: { creatorId, name: label.trim(), slug: sourceKey, sourceKey },
        // Deliberately empty: an existing theme carries the creator's name for it, and seeding
        // must never overwrite curation.
        update: {},
        select: { id: true },
      });

      await this.prisma.titleTheme.upsert({
        where: { titleId_themeId: { titleId, themeId: theme.id } },
        create: { titleId, themeId: theme.id },
        update: {},
      });
    }
  }
}
