import { expect, test } from '@playwright/test';
import {
  CREATOR,
  resetRateLimits,
  makeStaff,
  seedCreator,
  seedEntryFrom,
  setHidePending,
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

test('a moderator accepts a suggestion and it moves to the Accepted column', async ({ page }) => {
  await signIn(page, 500, 'patreon-mod-e2e');
  makeStaff('patreon-mod-e2e');
  seedEntryFrom('patreon-other-e2e', 'Princess Mononoke');

  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();

  await page.getByRole('button', { name: /move “Princess Mononoke”/i }).click();
  await page.getByRole('menuitem', { name: 'Accepted' }).click();

  await expect(page.getByRole('heading', { name: 'Accepted' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Suggestions' })).toHaveCount(0);
});

test('a patron reports an entry and a moderator dismisses it', async ({ page }) => {
  await signIn(page, 500, 'patreon-mod-e2e');
  makeStaff('patreon-mod-e2e');
  seedEntryFrom('patreon-other-e2e', 'Grave of the Fireflies');

  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByRole('button', { name: /report “Grave of the Fireflies”/i }).click();
  await page.getByLabel(/reason/i).selectOption('SPAM');
  await page.getByLabel(/what is wrong/i).fill('not a real suggestion');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText(/thanks/i)).toBeVisible();

  await page.getByRole('link', { name: 'Review queue' }).click();
  await page.waitForURL((url) => url.pathname.endsWith('/review'));
  await expect(page.getByText('not a real suggestion')).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText(/no open reports/i)).toBeVisible();
});

test('a moderator redacts a description and the board shows the redaction', async ({ page }) => {
  await signIn(page, 500, 'patreon-mod-e2e');
  makeStaff('patreon-mod-e2e');
  seedEntryFrom('patreon-other-e2e', 'Howls Moving Castle');

  await page.goto(`/c/${CREATOR.slug}/review`);
  await page.getByRole('button', { name: 'Redact' }).click();
  await page.getByLabel('Description').fill('[removed by a moderator]');
  await page.getByRole('button', { name: 'Save redaction' }).click();
  await expect(page.getByText('[removed by a moderator]')).toBeVisible();

  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByText('[removed by a moderator]')).toBeVisible();
});

test('a deleted entry leaves the board but stays in the review queue', async ({ page }) => {
  await signIn(page, 500, 'patreon-mod-e2e');
  makeStaff('patreon-mod-e2e');
  seedEntryFrom('patreon-other-e2e', 'Porco Rosso');

  await page.goto(`/c/${CREATOR.slug}/review`);
  await page.getByRole('button', { name: /move “Porco Rosso”/i }).click();
  await page.getByRole('menuitem', { name: 'Deleted' }).click();
  // Still reachable by the people who removed it — design §7 calls DELETED a restorable bin.
  await expect(page.getByRole('heading', { name: 'Porco Rosso' })).toBeVisible();

  // A patron sees nothing. Signing out is the cheapest way to become one.
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByText('Porco Rosso')).toHaveCount(0);
});

test('hidePendingFromPublic hides other patrons pending entries but not your own', async ({
  page,
}) => {
  seedEntryFrom('patreon-other-e2e', 'Kikis Delivery Service');
  setHidePending(true);

  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByLabel(/catalogue does not have/i).fill('My Neighbour Totoro');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  // Their own pending suggestion stays visible — otherwise the form reports success over an
  // empty board, which reads as a bug to the person who just used it.
  await expect(page.getByRole('heading', { name: 'My Neighbour Totoro' })).toBeVisible();
  await expect(page.getByText('Kikis Delivery Service')).toHaveCount(0);
});

test('a catalogue title shows where to watch it', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByLabel(/search films and shows/i).fill('spirited');
  await page.getByRole('button', { name: /spirited away \(2001\)/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Spirited Away/ })).toBeVisible();

  // The board never blocks on the availability provider: the first render carries no badge and
  // the refresh it queued arrives behind it. Reload until it lands rather than assuming one
  // reload is late enough — that assumption passed alone and failed in the full suite.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Netflix')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  // TMDB's terms require the attribution wherever this data is shown.
  await expect(page.getByText(/availability data by justwatch/i)).toBeVisible();
});

test('a patron can suggest a whole franchise', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/search films and shows/i).fill('ghibli');
  await page.getByRole('button', { name: /studio ghibli collection/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  // The name comes from the collection, not from anything typed — and it is a FRANCHISE, so it
  // had to resolve against TMDB's collection endpoint rather than its movie one.
  await expect(page.getByRole('heading', { name: 'Studio Ghibli Collection' })).toBeVisible();
});

test('a patron can compose, reorder and submit a watch order', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByRole('radio', { name: /watch order/i }).check();
  await page.getByLabel(/what to call it/i).fill('Ghibli in release order');

  await page.getByRole('button', { name: /add a step/i }).click();
  await page.getByLabel('Step 1 title').fill('Castle in the Sky');
  await page.getByRole('button', { name: /add a step/i }).click();
  await page.getByLabel('Step 2 title').fill('My Neighbour Totoro');

  // Reorder before submitting: the server numbers the steps from the order they arrive in, so
  // this is the assertion that the array order is what actually reaches it.
  await page.getByRole('button', { name: 'Move step 2 up' }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Ghibli in release order' })).toBeVisible();
  // Asserted through the rendered numbering rather than list position: the card is itself a
  // listitem, so a positional locator matches the card as well as its steps.
  const card = page.getByRole('listitem').filter({ hasText: 'Ghibli in release order' }).first();
  await expect(card).toContainText(/1\.\s*My Neighbour Totoro/);
  await expect(card).toContainText(/2\.\s*Castle in the Sky/);
});
