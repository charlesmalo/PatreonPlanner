import { expect, test } from '@playwright/test';
import {
  CREATOR,
  resetRateLimits,
  seedCreator,
  setPatreonIdentity,
  setVisibility,
} from './support';

/**
 * The whole point of this suite: it drives the real images through the real nginx proxy, so it
 * catches the class of bug both other suites miss — a route the SPA calls at a path the API does
 * not mount. Component tests use a fake client; API tests use supertest against the module. Only
 * this one exercises the contract between them.
 */

test.beforeEach(() => {
  seedCreator();
  // Every test starts from the same state regardless of what ran before, including CI retries.
  resetRateLimits();
});

async function signIn(
  page: import('@playwright/test').Page,
  patronCents?: number,
  patreonUserId = 'patreon-user-e2e',
) {
  await setPatreonIdentity({
    id: patreonUserId,
    fullName: 'Ada Lovelace',
    memberships: patronCents
      ? [
          {
            campaignId: CREATOR.campaignId,
            amountCents: patronCents,
            isActivePatron: true,
            tierIds: ['tier-e2e'],
          },
        ]
      : [],
  });
  await page.goto('/');
  await page.getByRole('link', { name: /sign in with patreon/i }).click();
  // Wait for the redirect chain — sign-in link, stub consent, real callback, back to WEB_ORIGIN —
  // to settle before returning. Asserting on the header alone returns while the final navigation
  // is still in flight, and the caller's next goto is then interrupted by it.
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
}

test('an anonymous visitor can read a public board', async ({ page }) => {
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByRole('heading', { name: CREATOR.displayName })).toBeVisible();
  await expect(page.getByText(/nothing suggested yet/i)).toBeVisible();
  // Not a patron, so no submit form.
  await expect(page.getByRole('heading', { name: /suggest something/i })).toBeHidden();
});

test('a gated board tells an anonymous visitor to sign in', async ({ page }) => {
  setVisibility('ANY_PATREON_USER');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByText(/sign in to see this board/i)).toBeVisible();
});

test('a signed-in non-patron is refused a subscribers-only board', async ({ page }) => {
  await signIn(page);
  setVisibility('SUBSCRIBERS_ONLY');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByText(/for the creator.s patrons/i)).toBeVisible();
});

test('a patron can sign in, suggest, upvote and sign out', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  // The capability flags came from the API, so the form is here only because the server said so.
  const form = page.getByRole('heading', { name: /suggest something/i });
  await expect(form).toBeVisible();

  await page.getByLabel(/catalogue does not have/i).fill('Spirited Away');
  await page.getByLabel(/why\?/i).fill('A classic worth revisiting.');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByText(/pending review/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Spirited Away' })).toBeVisible();

  const upvote = page.getByRole('button', { name: /upvote Spirited Away/i });
  await expect(upvote).toHaveAttribute('aria-pressed', 'false');
  await upvote.click();
  // Reconciled from the server's count, and the control now reports the true state.
  await expect(
    page.getByRole('button', { name: /remove upvote from Spirited Away/i }),
  ).toBeVisible();

  await page.reload();
  // Survives a reload: proof it was persisted and that hasUpvoted comes back per viewer.
  await expect(
    page.getByRole('button', { name: /remove upvote from Spirited Away — 1 upvotes/i }),
  ).toBeVisible();

  // The regression this suite was written for: sign-out posted to a path the API does not mount,
  // so the session survived a click that looked like it worked.
  await page.getByRole('button', { name: /sign out/i }).click();
  // signOut clears local state before navigating, so the signed-out header renders while the
  // navigation is still in flight. Wait for it to land, or the next goto is interrupted by it.
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('link', { name: /sign in with patreon/i })).toBeVisible();

  await page.goto(`/c/${CREATOR.slug}`);
  // Genuinely signed out: the board no longer offers the patron-only form.
  await expect(page.getByRole('heading', { name: /suggest something/i })).toBeHidden();
});

test('a duplicate suggestion is offered for upvote rather than added twice', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/catalogue does not have/i).fill('Akira');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Akira' })).toBeVisible();

  await page.getByLabel(/catalogue does not have/i).fill('akira!');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByText(/already on the board/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Akira' })).toHaveCount(1);
});

test('a non-Latin title survives the round trip', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  // The de-duplication key used to collapse every non-Latin title to the same value.
  await page.getByLabel(/catalogue does not have/i).fill('君の名は。');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: '君の名は。' })).toBeVisible();

  await page.getByLabel(/catalogue does not have/i).fill('기생충');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기생충' })).toBeVisible();
  await expect(page.getByText(/already on the board/i)).toBeHidden();
});

test('a patron can search the catalogue and suggest a canonical title', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/search films and shows/i).fill('spirited');
  await page.getByRole('button', { name: /spirited away \(2001\)/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  // The name and year come from the catalogue, not from anything typed.
  await expect(page.getByRole('heading', { name: /Spirited Away/ })).toBeVisible();
  await expect(page.getByText('(2001)')).toBeVisible();
});

test('the same catalogue title cannot be added twice to a board', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/search films and shows/i).fill('totoro');
  await page.getByRole('button', { name: /totoro \(1988\)/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Totoro/ })).toBeVisible();

  // Suggesting it again resolves to the same entry rather than adding a second — de-duplicated
  // on the canonical title id, not on spelling. (The cross-patron case is covered by the API
  // suite; driving two identities through the browser proved flaky for reasons unrelated to the
  // behaviour, and this exercises the same SPA-to-API contract.)
  await page.getByLabel(/search films and shows/i).fill('totoro');
  await page.getByRole('button', { name: /totoro \(1988\)/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  await expect(page.getByText(/already on the board/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Totoro/ })).toHaveCount(1);
});

test('a submitted title containing markup is shown as text', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/catalogue does not have/i).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  // Stored as text end to end, not merely escaped by a component test's fake.
  await expect(page.locator('main img')).toHaveCount(0);
});
