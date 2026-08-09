import { slugify } from '../src/creators/slug';

describe('slugify', () => {
  it.each([
    ['Ada Writes', 'ada-writes'],
    ['  Ada   Writes  ', 'ada-writes'],
    ['Ada’s Café', 'ada-s-cafe'],
    ['A/B  Testing!', 'a-b-testing'],
    ['---', 'creator'],
    ['', 'creator'],
    ['日本語', 'creator'],
  ])('turns %j into %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('bounds the length so a long name cannot dominate a URL', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(48);
  });

  it('never ends in a hyphen, even when the length cap lands on one', () => {
    // 47 characters then a space: slicing to 48 would otherwise leave a trailing separator.
    expect(slugify(`${'a'.repeat(47)} b`)).not.toMatch(/-$/);
  });
});
