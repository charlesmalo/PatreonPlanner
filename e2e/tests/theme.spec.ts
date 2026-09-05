import { expect, test } from '@playwright/test';

/**
 * The theme control, in a real browser.
 *
 * jsdom can prove the class lands on `<html>`; it cannot prove that anything looks different,
 * because it applies no stylesheet. These check the part that only a browser knows: that the
 * chosen theme actually changes the painted colours, survives a reload, and reaches the page
 * before the first paint rather than after it.
 */
test.describe('choosing a theme', () => {
  const menu = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: /theme/i });

  const choose = async (page: import('@playwright/test').Page, option: RegExp) => {
    await menu(page).click();
    await page.getByRole('menuitemradio', { name: option }).click();
  };

  /** Mean channel value of an `rgb(...)` string. Higher is lighter. */
  const lightness = (colour: string) => {
    const channels =
      colour
        .match(/\d+(\.\d+)?/g)
        ?.slice(0, 3)
        .map(Number) ?? [];
    return channels.reduce((total, channel) => total + channel, 0) / (channels.length || 1);
  };

  /** The painted surface, read from the element that actually carries the background. */
  const surface = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      // `body` is transparent here — the background lives on a wrapper — so walk up from the
      // header until something is actually painted rather than assuming which element it is.
      let node: HTMLElement | null = document.querySelector('header');
      while (node) {
        const colour = getComputedStyle(node).backgroundColor;
        if (colour && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
        node = node.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor;
    });

  test('dark and light paint differently', async ({ page }) => {
    await page.goto('/');

    await choose(page, /^dark$/i);
    const dark = await surface(page);

    await choose(page, /^light$/i);
    const light = await surface(page);

    expect(dark).not.toBe(light);
    // Not merely different — the right way round.
    expect(lightness(dark)).toBeLessThan(lightness(light));
  });

  test('the choice survives a reload, before the first paint', async ({ page }) => {
    // The inline script in index.html is what makes this true. Applying the theme from React
    // instead renders one frame in the wrong one — a white flash on every navigation for anybody
    // using the dark theme.
    await page.goto('/');
    await choose(page, /^dark$/i);

    await page.reload();

    // Read immediately, with no waiting: if the class arrived late this is already wrong.
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    expect(dark).toBe(true);
  });

  test('it overrides the operating system, in both directions', async ({ page }) => {
    // The whole point of a toggle. Following `prefers-color-scheme` alone is what the app did
    // before, and it left somebody on a dark machine unable to look at the light theme at all.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');

    await choose(page, /^light$/i);
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      false,
    );

    await page.emulateMedia({ colorScheme: 'light' });
    await choose(page, /^dark$/i);
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      true,
    );
  });

  test('System hands control back to the machine', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await choose(page, /^light$/i);

    await choose(page, /^system$/i);

    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      true,
    );
  });

  test('the slogan wears the puzzle pieces: pale, coral, pale', async ({ page }) => {
    // Outer/middle/outer is the pattern the mascot is holding. Only the middle is painted; the
    // outer two inherit the foreground, which is white on dark and readable on light — where a
    // literal white would be an invisible slogan.
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'Pitch. Plan. Play.' });

    await choose(page, /^dark$/i);
    await expect(heading.locator('span.text-brand')).toHaveText('Plan.');
    // The coral is pinned exactly, because it is sampled from the artwork and the two must agree.
    await expect(heading.locator('span.text-brand')).toHaveCSS('color', 'rgb(253, 93, 70)');
    const onDark = lightness(await heading.evaluate((el) => getComputedStyle(el).color));

    await choose(page, /^light$/i);
    await expect(heading.locator('span.text-brand')).toHaveCSS('color', 'rgb(253, 93, 70)');
    const onLight = lightness(await heading.evaluate((el) => getComputedStyle(el).color));

    // Asserted as lightness rather than an exact grey: which slate the theme picks is a design
    // choice that may move, while "pale on dark, dark on light" is the actual guarantee — it is
    // what stops the outer words being an invisible white on the light theme.
    expect(onDark).toBeGreaterThan(200);
    expect(onLight).toBeLessThan(100);
  });
});
