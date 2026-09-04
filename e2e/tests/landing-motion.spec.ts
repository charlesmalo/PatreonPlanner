import { expect, test } from '@playwright/test';

/**
 * The title card sequence, in a real browser — which is the only place it can be checked.
 *
 * jsdom computes no keyframes and applies no stylesheet, so the unit tests can only assert that
 * the three stages are present as text. Everything that actually makes this an animation lives in
 * CSS that a bundler rewrites and a cascade resolves, and both have already broken it once each:
 *
 *   - Tailwind purged the rules, because the class name was composed in JSX and its scanner reads
 *     source as text. The cards rendered and never moved.
 *   - The reduced-motion guard lost on specificity to the rules it was meant to override, so
 *     motion kept playing for anybody who had asked for none.
 *
 * Neither failed. Neither was visible from a unit test. Hence this.
 */
test.describe('the title card sequence', () => {
  const cards = (page: import('@playwright/test').Page) =>
    page.getByRole('listitem').filter({ hasText: /Pitch\.|Plan\.|Play\./ });

  test('leads with the slogan and the three stages', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Pitch. Plan. Play.' })).toBeVisible();
    await expect(cards(page)).toHaveCount(3);
  });

  test('actually animates, rather than rendering three still cards', async ({ page }) => {
    await page.goto('/');

    // Named individually: a bundler that drops the rules leaves `none` here, which is exactly
    // what shipped the first time.
    const names = await cards(page).evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).animationName),
    );
    expect(names).toEqual(['pp-card-one', 'pp-card-two', 'pp-card-three']);
  });

  test('lands them one after another rather than all at once', async ({ page }) => {
    await page.goto('/');
    // Early enough that the first has arrived and the last has not. Three cards fading in
    // together would satisfy every other assertion here.
    await page.waitForTimeout(250);

    const opacity = await cards(page).evaluateAll((els) =>
      els.map((el) => Number(getComputedStyle(el).opacity)),
    );
    expect(opacity[0]).toBeGreaterThan(opacity[2]);
  });

  test('settles with every card fully visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);

    const opacity = await cards(page).evaluateAll((els) =>
      els.map((el) => Number(getComputedStyle(el).opacity)),
    );
    expect(opacity).toEqual([1, 1, 1]);
  });

  test.describe('when the reader has asked for less motion', () => {
    test('nothing animates', async ({ page }) => {
      // Emulated before navigating, so the media query is already true when the stylesheet is
      // first evaluated rather than re-resolved afterwards.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');

      const names = await cards(page).evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).animationName),
      );
      expect(names).toEqual(['none', 'none', 'none']);
    });

    test('and the sequence is still all there', async ({ page }) => {
      // The guard removes the movement, not the meaning. Turning the animation off must leave the
      // finished state rather than the first frame of one.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');

      await expect(cards(page)).toHaveCount(3);
      const opacity = await cards(page).evaluateAll((els) =>
        els.map((el) => Number(getComputedStyle(el).opacity)),
      );
      expect(opacity).toEqual([1, 1, 1]);
      // Scoped to the cards: the slogan is also the page heading, so an unscoped match for
      // "Pitch." finds both and Playwright refuses. Asserting on the heading here would prove
      // the heading, which is a different claim.
      await expect(cards(page).first()).toContainText('Pitch.');
      await expect(cards(page).last()).toContainText('Play.');
    });
  });
});
