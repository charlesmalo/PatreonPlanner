import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from './safe-url';

/**
 * The three components that render submitter-chosen URLs each test `javascript:` against their
 * own markup. None of them had ever handed this function a string that is not a URL at all, so
 * the `catch` that rejects one had never executed — measured at 0 across the whole suite while
 * the file sat at 75% under a 91% global gate.
 *
 * Tested here directly rather than through a fourth component: this is the boundary, and a
 * boundary is worth asserting in the terms it is written in.
 */
describe('isSafeHttpUrl', () => {
  it('accepts http', () => {
    expect(isSafeHttpUrl('http://example.com/watch')).toBe(true);
  });

  it('accepts https', () => {
    expect(isSafeHttpUrl('https://example.com/watch')).toBe(true);
  });

  it('refuses javascript:, which parses as a URL rather than throwing', () => {
    // The case the function exists for, and the reason a try/catch alone would not be enough:
    // `new URL('javascript:alert(1)')` succeeds, so only the protocol check rejects it.
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('refuses data:', () => {
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('refuses a string that is not a URL', () => {
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });

  it('refuses the empty string', () => {
    expect(isSafeHttpUrl('')).toBe(false);
  });

  it('refuses a protocol-relative URL, which has no protocol to check', () => {
    // `//evil.example` is a valid href in a browser and is not a valid absolute URL, so it lands
    // in the catch. Worth pinning: it is the shape that looks safest and parses least.
    expect(isSafeHttpUrl('//evil.example/watch')).toBe(false);
  });
});
