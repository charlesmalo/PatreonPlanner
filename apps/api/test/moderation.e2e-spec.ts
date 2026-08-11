import { ModerationService } from '../src/moderation/moderation.service';
import { WordlistModerator } from '../src/moderation/wordlist-moderator';

describe('ModerationService', () => {
  const service = new ModerationService(new WordlistModerator());

  it('passes clean text', async () => {
    expect((await service.review(['A perfectly nice film'])).verdict).toBe('PASS');
  });

  it('blocks profanity', async () => {
    expect((await service.review(['this is shit'])).verdict).toBe('BLOCK');
  });

  it('catches obfuscated profanity', async () => {
    // The whole reason for a matcher rather than a substring list.
    expect((await service.review(['this is $h1t'])).verdict).toBe('BLOCK');
  });

  it('reviews every part, not just the first', async () => {
    expect((await service.review(['clean title', 'shit description'])).verdict).toBe('BLOCK');
  });

  it('reports the category alongside the verdict', async () => {
    const result = await service.review(['clean', 'shit']);
    expect(result.verdict).toBe('BLOCK');
    expect(result.categories).toContain('PROFANITY');
  });

  it('ignores empty, null and undefined parts', async () => {
    expect((await service.review(['ok', undefined, null, ''])).verdict).toBe('PASS');
  });
});
