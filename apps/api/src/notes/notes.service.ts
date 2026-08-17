import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NoteKind, Prisma } from '@prisma/client';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';

/** Bounded so one entry cannot become an unpaginated wall of text on a board card. */
export const MAX_NOTES_PER_ENTRY = 20;

/** The author is shown beside the note; the rest of the User row is not the reader's business. */
export const NOTE_FIELDS = {
  id: true,
  kind: true,
  body: true,
  plannedFor: true,
  createdAt: true,
  author: { select: { id: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.CreatorNoteSelect;

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  async write(
    creatorId: string,
    recommendationId: string,
    authorUserId: string,
    kind: NoteKind,
    body: string,
    plannedFor?: string | null,
  ) {
    // Scoped by creatorId: the guard proved access to this creator, not to this entry.
    const entry = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId },
      select: { id: true },
    });
    if (!entry) throw new NotFoundException();

    // A date on editor commentary has no meaning and nothing renders it. The check constraint
    // agrees; this turns it into a 400 rather than a 500. `null` is "no date", which is what a
    // client naturally sends on commentary, so it is not an error.
    if (kind !== 'TIMELINE' && plannedFor != null) {
      throw new BadRequestException('Only a timeline note can carry a planned date');
    }
    await this.assertClean(body, authorUserId, creatorId, recommendationId);

    // Counted and written under a lock on the entry: a read-then-write cap does not survive a
    // double-click, and the cap exists to stop an unpaginated wall of text on a board card.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Recommendation" WHERE id = ${recommendationId}::uuid FOR UPDATE`;
      const existing = await tx.creatorNote.count({ where: { recommendationId } });
      if (existing >= MAX_NOTES_PER_ENTRY) {
        throw new ConflictException('That entry already has too many notes');
      }

      return tx.creatorNote.create({
        data: {
          recommendationId,
          authorUserId,
          kind,
          body: body.trim(),
          plannedFor: plannedFor ? new Date(plannedFor) : null,
        },
        select: NOTE_FIELDS,
      });
    });
  }

  async edit(
    creatorId: string,
    noteId: string,
    actorUserId: string,
    body: string,
    plannedFor?: string | null,
  ) {
    const note = await this.find(creatorId, noteId);
    if (note.kind !== 'TIMELINE' && plannedFor != null) {
      throw new BadRequestException('Only a timeline note can carry a planned date');
    }
    await this.assertClean(body, actorUserId, creatorId, note.recommendationId);

    return this.prisma.creatorNote.update({
      where: { id: note.id },
      data: {
        body: body.trim(),
        // Omitted leaves the existing date; `null` clears it. Without the distinction there was
        // no way to unset one, and the input a client would try wrote the Unix epoch instead.
        ...(plannedFor === undefined ? {} : { plannedFor: plannedFor && new Date(plannedFor) }),
      },
      select: NOTE_FIELDS,
    });
  }

  async remove(creatorId: string, noteId: string): Promise<void> {
    const note = await this.find(creatorId, noteId);
    // A hard delete: a note has no upvotes, no de-duplication key and no audience relying on
    // its permanence, and someone who regrets writing it should be able to remove it.
    await this.prisma.creatorNote.delete({ where: { id: note.id } });
  }

  /** Scoped through the recommendation: a note id alone says nothing about which board it is on. */
  private async find(creatorId: string, noteId: string) {
    const note = await this.prisma.creatorNote.findFirst({
      where: { id: noteId, recommendation: { creatorId } },
      select: { id: true, kind: true, recommendationId: true },
    });
    if (!note) throw new NotFoundException();
    return note;
  }

  private async assertClean(
    body: string,
    userId: string,
    creatorId: string,
    recommendationId: string,
  ): Promise<void> {
    // Design §6.5: every user string goes through the pipeline. A TIMELINE note is published to
    // the board, so a creator's own words are not an exemption.
    const verdict = await this.moderation.review(
      { creatorId, userId, type: 'NOTE', id: recommendationId },
      [body],
    );
    if (verdict.verdict === 'BLOCK') {
      this.logger.warn(`Blocked note text from user ${userId}`);
      throw new BadRequestException('Rejected');
    }
  }
}
