import { Injectable } from '@nestjs/common';
import { ModerationResultData, ModerationVerdict, Moderator } from './moderation.types';
import { WordlistModerator } from './wordlist-moderator';

const SEVERITY: Record<ModerationVerdict, number> = { PASS: 0, FLAG: 1, BLOCK: 2 };

@Injectable()
export class ModerationService {
  private readonly moderators: Moderator[];

  constructor(wordlist: WordlistModerator) {
    // Plan 07's ML stage joins this list; nothing else changes.
    this.moderators = [wordlist];
  }

  /** Reviews every part and returns the most severe verdict any moderator produced. */
  async review(parts: Array<string | undefined | null>): Promise<ModerationResultData> {
    let worst: ModerationResultData = { verdict: 'PASS', categories: [], source: 'WORDLIST' };
    for (const part of parts) {
      if (!part) continue;
      for (const moderator of this.moderators) {
        const result = await moderator.review(part);
        if (SEVERITY[result.verdict] > SEVERITY[worst.verdict]) worst = result;
      }
    }
    return worst;
  }
}
