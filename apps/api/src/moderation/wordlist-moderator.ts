import { Injectable } from '@nestjs/common';
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';
import { ModerationResultData, Moderator } from './moderation.types';

/**
 * A matcher rather than a substring list: the transformers fold leetspeak and separators, so
 * "$h1t" is caught where a naive contains() would not.
 */
@Injectable()
export class WordlistModerator implements Moderator {
  private readonly matcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });

  async review(text: string): Promise<ModerationResultData> {
    const matched = this.matcher.hasMatch(text);
    return {
      verdict: matched ? 'BLOCK' : 'PASS',
      categories: matched ? ['PROFANITY'] : [],
      source: 'WORDLIST',
    };
  }
}
