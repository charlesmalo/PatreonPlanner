import { expect, test } from '@playwright/test';
import {
  CREATOR,
  clearStaff,
  makeOwner,
  makeStaff,
  resetRateLimits,
  seedCreator,
  setPatreonIdentity,
} from './support';

/**
 * The settings page, driven through the real stack.
 *
 * It had none of this. The page shipped with `submitMinTierId` and `upvoteMinTierId` read from the
 * API, held in state and sent back on save — and **no control to set either**. Every unit test
 * passed, because they tested the parts that existed. A test that drives the real control against
 * the real server is the one that would have noticed, which is why these are here rather than in
 * jsdom against a fake client.
 */

test.beforeEach(() => {
  seedCreator();
  clearStaff();
  resetRateLimits();
});

async function signIn(page: import('@playwright/test').Page, patreonUserId: string) {
  await setPatreonIdentity({ id: patreonUserId, fullName: 'Ada Lovelace', memberships: [] });
  await page.goto('/');
  await page.getByRole('link', { name: /sign in with patreon/i }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
}

test('an owner can set who may suggest, and it survives a reload', async ({ page }) => {
  await signIn(page, 'settings-owner');
  makeOwner('settings-owner');
  await page.goto(`/c/${CREATOR.slug}/settings`);

  const gate = page.getByLabel(/who may suggest something/i);
  await expect(gate).toBeVisible();
  // The unset option plus the board's tiers, offered from the creator's profile rather than
  // typed in, so a tier belonging to nobody cannot be chosen. Not an exact count: this suite
  // shares one database and other specs add tiers to the same board.
  await expect(gate.locator('option').first()).toHaveText(/any supporter, at any tier/i);
  expect(await gate.locator('option').count()).toBeGreaterThan(1);

  await gate.selectOption({ index: 1 });
  await expect(page.getByRole('status')).toHaveText(/saved/i);

  // Reload rather than trusting the optimistic update: the page applies the change before the
  // server answers, so an unsaved setting looks identical to a saved one until you come back.
  await page.reload();
  await expect(page.getByLabel(/who may suggest something/i)).not.toHaveValue('');
});

test('the unset option does not claim the board is open to anyone', async ({ page }) => {
  // A null gate drops the requirement to any active patron; it does not remove it. A settings
  // page that overstates what it just turned off is worse than one that never offered it.
  await signIn(page, 'settings-owner-copy');
  makeOwner('settings-owner-copy');
  await page.goto(`/c/${CREATOR.slug}/settings`);

  const gate = page.getByLabel(/who may upvote/i);
  // `allTextContents` does not auto-wait, so it returns an empty list on a page still rendering.
  await expect(gate).toBeVisible();
  const options = await gate.locator('option').allTextContents();
  expect(options[0]).toMatch(/any supporter, at any tier/i);
  expect(options.join(' ')).not.toMatch(/\banyone\b/i);
});

test('changing who can read the board takes effect for a signed-out reader', async ({ page }) => {
  // The default is private because a readable board is a list of what a creator is watching, and
  // those get scraped to file fraudulent DMCA claims. This drives that end to end: set through
  // the page, enforced by the server, seen by somebody with no session at all.
  await signIn(page, 'settings-owner-vis');
  makeOwner('settings-owner-vis');
  await page.goto(`/c/${CREATOR.slug}/settings`);

  await page.getByRole('radio', { name: /only my supporters/i }).check();
  await expect(page.getByRole('status')).toHaveText(/saved/i);

  await page.getByRole('button', { name: /sign out/i }).click();
  // Signing out redirects home. Waiting only for the signed-out header is not enough — it is
  // already true on this page while that navigation is still in flight, and the goto below is
  // then aborted by it. Wait for the navigation to land.
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('link', { name: /sign in with patreon/i })).toBeVisible();
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByText(/sign in to see this board/i)).toBeVisible();
});

test('a moderator without MANAGE_POLICY is refused, and told why', async ({ page }) => {
  // Running the queue and deciding who may read the board are different powers. Somebody who
  // arrived by invite link holds the first and not the second.
  await signIn(page, 'settings-mod');
  makeStaff('settings-mod');
  await page.goto(`/c/${CREATOR.slug}/settings`);

  await expect(page.getByText(/do not have permission/i)).toBeVisible();
  await expect(page.getByLabel(/who may suggest something/i)).toBeHidden();
});
