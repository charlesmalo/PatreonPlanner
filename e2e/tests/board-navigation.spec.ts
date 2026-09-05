import { expect, test } from '@playwright/test';
import { CREATOR, seedCreator } from './support';

/**
 * Moving between board columns, in a real browser.
 *
 * The unit tests cover the buttons, the tab strip and the keyboard. They cannot cover swiping:
 * jsdom defines no `PointerEvent`, so a dispatched gesture arrives with neither `pointerType` nor
 * coordinates, and anything written against it is testing how the code treats NaN rather than
 * how it treats a finger.
 */
const BOARD = `/c/${CREATOR.slug}`;

// Boards are subscribers-only by default now, so a spec that never signs in has to say the board
// is readable — `seedCreator` sets it public, which is what these tests need to be about
// navigation rather than about access.
test.beforeEach(() => {
  seedCreator();
});

const track = (page: import('@playwright/test').Page) =>
  page.locator('[role="tabpanel"]').first().locator('xpath=..');

const offset = async (page: import('@playwright/test').Page) =>
  track(page).evaluate((el) => getComputedStyle(el).transform);

/**
 * A finger, or a stylus — anything that is not a mouse.
 *
 * `page.mouse` cannot drive this: it sends `pointerType: 'mouse'`, which the board deliberately
 * ignores because a mouse already has arrows and a wheel. So the gesture is dispatched as real
 * `PointerEvent`s — constructed by the browser, with genuine coordinates and a genuine pointer
 * type, which is exactly what jsdom could not provide.
 */
async function swipe(
  page: import('@playwright/test').Page,
  dx: number,
  dy = 0,
  pointerType: 'touch' | 'mouse' = 'touch',
) {
  await track(page).evaluate(
    (el, { dx: deltaX, dy: deltaY, pointerType: kind }) => {
      const strip = el.parentElement as HTMLElement;
      const box = strip.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + Math.min(box.height / 2, 200);
      const fire = (type: string, atX: number, atY: number) =>
        strip.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: kind,
            isPrimary: true,
            clientX: atX,
            clientY: atY,
          }),
        );

      fire('pointerdown', x, y);
      // In steps, because a single jump is not a gesture and the handler waits for a direction.
      for (let step = 1; step <= 4; step += 1) {
        fire('pointermove', x + (deltaX * step) / 4, y + (deltaY * step) / 4);
      }
      fire('pointerup', x + deltaX, y + deltaY);
    },
    { dx, dy, pointerType },
  );
}

test.describe('moving between columns', () => {
  test('the arrows move one column at a time', async ({ page }) => {
    await page.goto(BOARD);
    await page.getByRole('tab', { name: 'Suggestions' }).waitFor();
    const start = await offset(page);

    await page.getByRole('button', { name: /go to accepted/i }).click();
    await page.waitForTimeout(400);

    expect(await offset(page)).not.toBe(start);
    await expect(page.getByRole('tab', { name: 'Accepted' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the strip jumps straight to a column', async ({ page }) => {
    await page.goto(BOARD);

    await page.getByRole('tab', { name: 'Completed' }).click();

    await expect(page.getByRole('tab', { name: 'Completed' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the first column has nothing before it', async ({ page }) => {
    await page.goto(BOARD);
    await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

    await expect(page.getByRole('button', { name: /no column before this one/i })).toBeDisabled();
  });

  test('the keyboard moves between columns without touching the mouse', async ({ page }) => {
    await page.goto(BOARD);
    await page.getByRole('tab', { name: 'Suggestions' }).focus();

    await page.keyboard.press('ArrowRight');

    await expect(page.getByRole('tab', { name: 'Accepted' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the off-screen columns cannot be tabbed into', async ({ page }) => {
    // Three invisible columns of focusable cards is a keyboard trap: tabbing off the last visible
    // card walks straight into them.
    await page.goto(BOARD);
    await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

    const inert = await page
      .locator('[role="tabpanel"]')
      .evaluateAll((panels) => panels.map((panel) => panel.hasAttribute('inert')));
    expect(inert[0]).toBe(false);
    expect(inert.slice(1).every(Boolean)).toBe(true);
  });

  test.describe('swiping', () => {
    test('dragging left brings the next column in', async ({ page }) => {
      // The content follows the finger: pulling it leftwards reveals what is to the right.
      await page.goto(BOARD);
      await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

      await swipe(page, -200);
      await page.waitForTimeout(400);

      await expect(page.getByRole('tab', { name: 'Accepted' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    test('dragging right goes back', async ({ page }) => {
      await page.goto(BOARD);
      await page.getByRole('tab', { name: 'Accepted' }).click();

      await swipe(page, 200);
      await page.waitForTimeout(400);

      await expect(page.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    test('a mostly-vertical drag is left to the column, which has to stay scrollable', async ({
      page,
    }) => {
      await page.goto(BOARD);
      await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

      await swipe(page, 60, 240);
      await page.waitForTimeout(400);

      await expect(page.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    test('a short drag is a tap that moved, not a swipe', async ({ page }) => {
      await page.goto(BOARD);
      await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

      await swipe(page, -20);
      await page.waitForTimeout(400);

      await expect(page.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    test('a mouse drag is left alone, because a mouse has arrows and a wheel', async ({ page }) => {
      // The same gesture as the passing case above, differing in exactly one property. Driving
      // it with `page.mouse` instead would land the press on a card and be skipped as a card
      // drag — passing for a reason that has nothing to do with pointer type.
      await page.goto(BOARD);
      await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

      await swipe(page, -200, 0, 'mouse');
      await page.waitForTimeout(400);

      await expect(page.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    test('one long drag moves one column, not all of them', async ({ page }) => {
      await page.goto(BOARD);
      await page.getByRole('tab', { name: 'Suggestions' }).waitFor();

      await swipe(page, -900);
      await page.waitForTimeout(400);

      await expect(page.getByRole('tab', { name: 'Accepted' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });
});
