import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ModerationResultData,
  ModerationSubject,
  ModerationVerdict,
  Moderator,
} from './moderation.types';
import { WordlistModerator } from './wordlist-moderator';

const SEVERITY: Record<ModerationVerdict, number> = { PASS: 0, FLAG: 1, BLOCK: 2 };

@Injectable()
export class ModerationService {
  private readonly moderators: Moderator[];

  constructor(
    wordlist: WordlistModerator,
    private readonly prisma: PrismaService,
  ) {
    // Design §6.5's ML stage joins this list; nothing else changes.
    this.moderators = [wordlist];
  }

  /**
   * Reviews every part, returns the most severe verdict any moderator produced, and records it.
   *
   * The subject is a parameter rather than a separate `record()` call so that reviewing without
   * recording is not something a call site can do by omission.
   */
  async review(
    subject: ModerationSubject,
    parts: Array<string | undefined | null>,
  ): Promise<ModerationResultData> {
    let worst: ModerationResultData = { verdict: 'PASS', categories: [], source: 'WORDLIST' };
    for (const part of parts) {
      if (!part) continue;
      for (const moderator of this.moderators) {
        const result = await moderator.review(part, subject.creatorId);
        if (SEVERITY[result.verdict] > SEVERITY[worst.verdict]) worst = result;
      }
    }

    // PASS is the absence of a row. Everything a user writes comes through here and almost all
    // of it passes, so recording those would be the largest table in the database, holding a
    // number nobody needs.
    if (worst.verdict !== 'PASS') {
      await this.prisma.moderationResult.create({
        data: {
          creatorId: subject.creatorId,
          userId: subject.userId,
          subjectType: subject.type,
          subjectId: subject.id ?? null,
          verdict: worst.verdict,
          categories: worst.categories,
          source: worst.source,
        },
      });
    }
    return worst;
  }
}
