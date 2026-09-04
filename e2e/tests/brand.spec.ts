import { expect, test } from '@playwright/test';

/**
 * That the logo actually loads.
 *
 * A missing asset is the quietest kind of visual defect: `<img>` keeps its box, the layout is
 * unchanged, and nothing throws — the mark simply becomes a broken-image icon. No unit test sees
 * it, because jsdom never fetches. Only the built image, served by the real nginx, can answer
 * whether the file survived the bundle and the path still points at it.
 */
test.describe('the logo and mascot', () => {
  const mark = (page: import('@playwright/test').Page) =>
    page.locator('header img[src="/brand/mascot.png"]');

  test('the mascot is in the header and its bytes decoded', async ({ page }) => {
    await page.goto('/');

    // naturalWidth rather than visibility: a broken image is still visible and still has a box.
    // Only this distinguishes "the element is there" from "the file arrived".
    const natural = await mark(page).evaluate((el: HTMLImageElement) => el.naturalWidth);
    expect(natural).toBeGreaterThan(0);
  });

  test('the mark is decorative and the product name is real text', async ({ page }) => {
    // The link already says PatreonPlanner. Naming the mascot again would have a screen reader
    // announce the same thing twice — and the name must stay text rather than becoming pixels,
    // which is also why the generator's horizontal lockup is not used here.
    await page.goto('/');

    await expect(mark(page)).toHaveAttribute('alt', '');
    await expect(mark(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('link', { name: 'PatreonPlanner' })).toBeVisible();
  });

  test('the favicon is served as a real image', async ({ page }) => {
    const response = await page.goto('/brand/favicon.png');

    expect(response?.status()).toBe(200);
    // nginx answers the SPA fallback with 200 and text/html for anything missing, so a status
    // check alone would pass for a file that is not there at all.
    expect(response?.headers()['content-type']).toBe('image/png');
  });

  test('nothing but the two brand assets is published', async ({ page }) => {
    // `public/` is copied into the image wholesale and served to anyone who asks. Mockups and
    // internal notes have been known to end up there.
    for (const path of ['/brand/mockup-mug.jpg', '/brand/README.md']) {
      const response = await page.goto(path);
      expect(response?.headers()['content-type']).toContain('text/html');
    }
  });
});
