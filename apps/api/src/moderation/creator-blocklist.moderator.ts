import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationResultData, Moderator } from './moderation.types';

/** Normalised the same way on write and on match, so neither side has to care how it was typed. */
export function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

/**
 * Design §6.5(a)'s per-creator list. Deliberately a plain substring test: the `obscenity` stage
 * already folds leetspeak and separators for the global list, and building a matcher per creator
 * per submission would be a cost paid on every request for a dozen words a creator typed
 * themselves.
 */
@Injectable()
export class CreatorBlocklistModerator implements Moderator {
  constructor(private readonly prisma: PrismaService) {}

  async review(text: string, creatorId: string): Promise<ModerationResultData> {
    const words = await this.prisma.creatorBlockword.findMany({
      where: { creatorId },
      select: { pattern: true, action: true },
    });
    if (words.length === 0) return PASS;

    const haystack = normalizePattern(text);
    // The harsher verdict wins when several match, matching how the pipeline combines its stages.
    const hit =
      words.find((word) => word.action === 'BLOCK' && haystack.includes(word.pattern)) ??
      words.find((word) => haystack.includes(word.pattern));
    if (!hit) return PASS;

    return { verdict: hit.action, categories: ['CREATOR_BLOCKLIST'], source: 'CREATOR' };
  }
}

const PASS: ModerationResultData = { verdict: 'PASS', categories: [], source: 'CREATOR' };
