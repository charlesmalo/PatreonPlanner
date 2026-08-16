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
    // Twice at most. Every label is resolved before any assignment is written, so a merge
    // committing inside that window leaves the resolved ids pointing at a theme that no longer
    // exists — a foreign key violation that would otherwise cost this title every one of its
    // labels, permanently, because `enrichedAt` is stamped whether or not this succeeded.
    // Resolving again is enough: the mapping now points at the theme that won the merge.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const themeIds: string[] = [];
      for (const label of labels) {
        const id = await this.resolveTheme(creatorId, label);
        if (id) themeIds.push(id);
      }
      if (themeIds.length === 0) return;

      try {
        // One statement rather than an upsert per label: a popular film carries dozens of
        // keywords, and a per-row round trip inside a job loop multiplies by every creator
        // holding the title.
        await this.prisma.titleTheme.createMany({
          data: themeIds.map((themeId) => ({ titleId, themeId })),
          skipDuplicates: true,
        });
        return;
      } catch (error) {
        const merged =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
        if (!merged || attempt === 2) throw error;
      }
    }
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

    return this.prisma.$transaction(async (tx) => {
      // Both rows are locked before anything is read, in id order.
      //
      // Read committed — Prisma's default — is not enough here. Two merges chaining through the
      // same theme (X into Y, then Y into Z) each took their snapshot before the other's writes
      // landed, so the second cascaded away what the first had just written: the title ended with
      // no theme and the label mapping was gone, which is exactly the resurrection this feature
      // exists to prevent. Both callers got a 200. Measured at 8 rounds in 10.
      //
      // Ordering by id rather than by role is what keeps X-into-Y and Y-into-X from deadlocking.
      // The lock also serialises against the enrichment job, whose insert into TitleTheme needs a
      // key-share lock on the theme rows this holds.
      const [first, second] = [id, intoId].sort();
      const locked = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Theme"
         WHERE "id" IN (${first}::uuid, ${second}::uuid)
           AND "creatorId" = ${creatorId}::uuid
         ORDER BY "id"
         FOR UPDATE
      `;
      // 404 rather than 403 for a theme on another board: the id is not this caller's to know
      // about either way, and the two answers would tell them apart. Also covers the loser of a
      // race, whose theme was merged away while it waited on the lock.
      const target = locked.find((theme) => theme.id === intoId);
      if (locked.length !== 2 || !target) throw new NotFoundException();

      // One statement rather than reading every assignment into memory and writing it back: a
      // theme on a large board would otherwise be a round trip per title inside a transaction
      // with a five-second default timeout. ON CONFLICT because a title carrying both themes
      // already satisfies the winner.
      await tx.$executeRaw`
        INSERT INTO "TitleTheme" ("titleId", "themeId")
        SELECT "titleId", ${intoId}::uuid FROM "TitleTheme" WHERE "themeId" = ${id}::uuid
        ON CONFLICT DO NOTHING
      `;
      // Before the delete, which would otherwise cascade them away. Scoped by creator as well as
      // theme: this is the one write that could carry a mapping across a tenant boundary.
      await tx.themeSource.updateMany({
        where: { themeId: id, creatorId },
        data: { themeId: intoId },
      });
      await tx.theme.delete({ where: { id } });

      return target;
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
    try {
      await this.prisma.themeSource.create({ data: { creatorId, sourceKey, themeId } });
      return themeId;
    } catch (error) {
      // Prisma compiles an upsert with an empty update to a select followed by an insert, not to
      // ON CONFLICT, so two enrichment passes reaching this line together left one of them
      // holding an unhandled P2002 — which cost that title every one of its labels. Whoever
      // recorded the label first owns it; theirs is the mapping of record.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.themeSource.findUnique({
          where: { creatorId_sourceKey: { creatorId, sourceKey } },
          select: { themeId: true },
        });
        return winner?.themeId ?? themeId;
      }
      throw error;
    }
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
