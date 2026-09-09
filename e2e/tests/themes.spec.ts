import { expect, test } from '@playwright/test';
import {
  CREATOR,
  clearIntelligence,
  clearStaff,
  makeOwner,
  makeStaff,
  resetRateLimits,
  seedCreator,
  seedTheme,
  setPatreonIdentity,
} from './support';

/**
 * Managing themes, through the real stack.
 *
 * `PATCH`, `DELETE` and `POST :id/merge` had existed since themes shipped and the client only
 * ever read the list, so `MANAGE_THEMES` was a permission a creator could grant for powers nobody
 * could exercise. These drive the controls against the endpoints that were already there.
 */
test.beforeEach(() => {
  seedCreator();
  clearStaff();
  clearIntelligence();
  resetRateLimits();
});

async function signIn(page: import('@playwright/test').Page, patreonUserId: string) {
  await setPatreonIdentity({ id: patreonUserId, fullName: 'Ada Lovelace', memberships: [] });
  await page.goto('/');
  await page.getByRole('link', { name: /sign in with patreon/i }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
}

test('an owner renames a theme, and it stays renamed', async ({ page }) => {
  seedTheme('Anime', []);
  await signIn(page, 'themes-owner');
  makeOwner('themes-owner');
  await page.goto(`/c/${CREATOR.slug}/themes`);

  await page.getByRole('button', { name: 'Rename Anime' }).click();
  const field = page.getByLabel(/new name/i);
  await field.fill('Animation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Animation')).toBeVisible();

  // The server's list, not the page's optimism.
  await page.reload();
  await expect(page.getByText('Animation')).toBeVisible();
  await expect(page.getByText('Anime', { exact: true })).toHaveCount(0);
});

test('two themes that mean the same thing can be merged into one', async ({ page }) => {
  // The case merging exists for, and the one a board actually accumulates: themes are suggested
  // automatically, so "Anime" and "anime" both appear and neither is wrong.
  seedTheme('Anime', []);
  seedTheme('anime2', []);
  await signIn(page, 'themes-merger');
  makeOwner('themes-merger');
  await page.goto(`/c/${CREATOR.slug}/themes`);
  await expect(page.getByText('anime2')).toBeVisible();

  await page.getByRole('button', { name: 'Merge anime2' }).click();
  await page.getByLabel(/merge into/i).selectOption({ label: 'Anime' });
  await expect(page.getByText(/cannot be undone/i)).toBeVisible();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();

  await expect(page.getByText('anime2')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('anime2')).toHaveCount(0);
  await expect(page.getByText('Anime', { exact: true })).toBeVisible();
});

test('a moderator without MANAGE_THEMES is refused, and told where it comes from', async ({
  page,
}) => {
  seedTheme('Anime', []);
  await signIn(page, 'themes-mod');
  // makeStaff grants the full set, so the permission is removed to leave a moderator who has
  // every other power and not this one — which is the case the page has to get right.
  makeStaff('themes-mod');
  const { seed } = await import('./support');
  seed(
    `UPDATE "CreatorStaff" SET permissions = ARRAY['MOVE_ENTRIES']::"StaffPermission"[] WHERE "creatorId" = '${CREATOR.id}';`,
  );

  await page.goto(`/c/${CREATOR.slug}/themes`);
  await expect(page.getByText(/do not have permission/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename Anime' })).toHaveCount(0);
});
