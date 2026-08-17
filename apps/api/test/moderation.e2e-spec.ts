import { CreatorBlocklistModerator } from '../src/moderation/creator-blocklist.moderator';
import { ModerationService } from '../src/moderation/moderation.service';
import { WordlistModerator } from '../src/moderation/wordlist-moderator';

describe('ModerationService', () => {
  // No database here: this suite is about how the stages combine, so the per-creator stage is
  // given an empty list and the recording is a no-op. The blocklist has its own integration
  // suite, and the recording has one too.
  const empty = { creatorBlockword: { findMany: async () => [] } };
  const recorded: Array<Record<string, unknown>> = [];
  const prisma = {
    moderationResult: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        recorded.push(data);
        return { id: 'rec-1' };
      },
    },
  };
  const service = new ModerationService(
    new WordlistModerator(),
    new CreatorBlocklistModerator(empty as never),
    prisma as never,
  );
  const subject = { creatorId: 'c1', userId: 'u1', type: 'RECOMMENDATION' as const };

  it('passes clean text', async () => {
    expect((await service.review(subject, ['A perfectly nice film'])).verdict).toBe('PASS');
  });

  it('blocks profanity', async () => {
    expect((await service.review(subject, ['this is shit'])).verdict).toBe('BLOCK');
  });

  it('catches obfuscated profanity', async () => {
    // The whole reason for a matcher rather than a substring list.
    expect((await service.review(subject, ['this is $h1t'])).verdict).toBe('BLOCK');
  });

  it('reviews every part, not just the first', async () => {
    expect((await service.review(subject, ['clean title', 'shit description'])).verdict).toBe(
      'BLOCK',
    );
  });

  it('reports the category alongside the verdict', async () => {
    const result = await service.review(subject, ['clean', 'shit']);
    expect(result.verdict).toBe('BLOCK');
    expect(result.categories).toContain('PROFANITY');
  });

  it('ignores empty, null and undefined parts', async () => {
    expect((await service.review(subject, ['ok', undefined, null, ''])).verdict).toBe('PASS');
  });
});
