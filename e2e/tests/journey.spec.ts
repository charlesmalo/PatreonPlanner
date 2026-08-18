import { expect, test } from '@playwright/test';
import {
  CREATOR,
  forgetAllSessions,
  resetRateLimits,
  clearAbuse,
  clearIntelligence,
  clearStaff,
  makeOwner,
  makeStaff,
  seedCreator,
  seedRelation,
  seedTheme,
  timeOutPatron,
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
  // Strikes outlive a test otherwise, and a timed-out patron cannot submit anything.
  clearAbuse();
  clearStaff();
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

test('a reader whose session ended is told so, not left looking signed in', async ({ page }) => {
  // The session is fetched once when the page loads. Anything that ends it afterwards — an
  // expired or revoked session, a sign-out in another tab, a restarted session store — used to
  // leave the header showing a name while every write failed telling the reader to sign in.
  await signIn(page, 500, 'patreon-stale-e2e');
  seedEntryFrom('patreon-other-e2e', 'Nausicaa');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  forgetAllSessions();

  await page.getByRole('button', { name: /report “Nausicaa”/i }).click();
  await page.getByLabel(/reason/i).selectOption('SPAM');
  await page.getByRole('button', { name: 'Send report' }).click();

  // The header stops claiming otherwise, so the sign-in link is there to act on.
  await expect(page.getByRole('link', { name: /sign in with patreon/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
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

test('a film nests under its franchise on the board', async ({ page }) => {
  clearIntelligence();
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  // Both on the board first — nesting is a per-board projection, so it only appears once the
  // container is there too.
  await page.getByLabel(/search films and shows/i).fill('ghibli');
  await page.getByRole('button', { name: /studio ghibli collection/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Studio Ghibli Collection' })).toBeVisible();

  await page.getByLabel(/search films and shows/i).fill('spirited');
  await page.getByRole('button', { name: /spirited away \(2001\)/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Spirited Away' })).toBeVisible();

  seedRelation(129, 10, 'SAME_FRANCHISE');
  await page.reload();

  // The film is rendered *inside* the collection's card, not merely after it.
  const franchise = page
    .getByRole('listitem')
    .filter({ hasText: 'Studio Ghibli Collection' })
    .first();
  await expect(franchise.getByRole('heading', { name: 'Spirited Away' })).toBeVisible();
});

test('a patron can narrow the board to one theme', async ({ page }) => {
  clearIntelligence();
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/search films and shows/i).fill('spirited');
  await page.getByRole('button', { name: /spirited away \(2001\)/i }).click();
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Spirited Away' })).toBeVisible();

  await page.getByLabel(/catalogue does not have/i).fill('An unthemed link');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'An unthemed link' })).toBeVisible();

  seedTheme('Anime', [129]);
  await page.reload();

  await page.getByRole('button', { name: /Anime \(1\)/ }).click();
  await expect(page.getByRole('heading', { name: 'Spirited Away' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'An unthemed link' })).toHaveCount(0);

  // Clicking again clears it.
  await page.getByRole('button', { name: /Anime \(1\)/ }).click();
  await expect(page.getByRole('heading', { name: 'An unthemed link' })).toBeVisible();
});

test('a timed-out patron can still read and upvote, but not suggest', async ({ page }) => {
  // Design §6.4: a timeout blocks submission only. Losing a board you paid for would be a
  // punishment out of all proportion to a blocked word.
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByLabel(/catalogue does not have/i).fill('Before the timeout');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Before the timeout' })).toBeVisible();

  timeOutPatron('patreon-user-e2e');
  await page.reload();

  // Reading still works.
  await expect(page.getByRole('heading', { name: 'Before the timeout' })).toBeVisible();
  // So does upvoting.
  await page
    .getByRole('button', { name: /upvote/i })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /1 upvote/i })).toBeVisible();

  // Suggesting does not, and the refusal carries a time without explaining itself.
  await page.getByLabel(/catalogue does not have/i).fill('During the timeout');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByText(/cannot suggest anything until/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'During the timeout' })).toHaveCount(0);
});

test('an owner invites a moderator, who accepts and can then be removed', async ({
  page,
  context,
}) => {
  await signIn(page, 500, 'patreon-owner-e2e');
  makeOwner('patreon-owner-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByRole('link', { name: 'Moderators' }).click();
  await page.waitForURL((url) => url.pathname.endsWith('/staff'));
  await page.getByRole('button', { name: /invite a moderator/i }).click();

  const link = await page.getByLabel(/send this link/i).inputValue();
  // The token lives in the fragment, which browsers never send to a server — so it stays out of
  // the access log a path would have written it to.
  expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{32,}$/);

  // A second browser context, so the invitee is a genuinely different session rather than the
  // same one wearing a different identity — which is what made an earlier two-identity journey
  // flaky.
  const invitee = await context.browser()!.newContext();
  const inviteePage = await invitee.newPage();
  await signIn(inviteePage, 500, 'patreon-invitee-e2e');
  const inviteUrl = new URL(link);
  await inviteePage.goto(`${inviteUrl.pathname}${inviteUrl.hash}`);
  await inviteePage.getByRole('button', { name: /accept/i }).click();
  await expect(inviteePage.getByRole('heading', { name: /you now moderate/i })).toBeVisible();

  // The power is real: the review queue is staff-only.
  await inviteePage.goto(`/c/${CREATOR.slug}/review`);
  await expect(inviteePage.getByRole('heading', { name: /review queue/i })).toBeVisible();

  // And revocable.
  await page.reload();
  await page
    .getByRole('button', { name: /^Remove/ })
    .first()
    .click();
  await expect(page.getByText(/no longer a moderator/i)).toBeVisible();

  await inviteePage.goto(`/c/${CREATOR.slug}/review`);
  await expect(inviteePage.getByText(/do not moderate this board/i)).toBeVisible();
  await invitee.close();
});

test('a moderator writes notes, and only the timeline one reaches the board', async ({ page }) => {
  const PRIVATE = 'internal thinking nobody outside should read';
  await signIn(page, 500, 'patreon-mod-e2e');
  makeStaff('patreon-mod-e2e');
  seedEntryFrom('patreon-other-e2e', 'Princess Mononoke');

  await page.goto(`/c/${CREATOR.slug}/review`);

  // Exact: the delete control's accessible name also contains "note".
  await page.getByLabel('Note', { exact: true }).fill(PRIVATE);
  await page.getByRole('button', { name: /add note/i }).click();
  await expect(page.getByText(PRIVATE)).toBeVisible();

  await page.getByLabel('Kind').selectOption('TIMELINE');
  await page.getByLabel('Note', { exact: true }).fill('Covering this in March');
  await page.getByRole('button', { name: /add note/i }).click();
  await expect(page.getByText('Covering this in March')).toBeVisible();

  // The board shows the timeline note and does not contain the commentary anywhere — asserted
  // against the whole page, because the kind is the only thing keeping them apart.
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByText('Covering this in March')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(PRIVATE);
});

test('a misspelling surfaces the existing entry, and upvoting it avoids a duplicate', async ({
  page,
}) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/catalogue does not have/i).fill('Spirited Away');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Spirited Away' })).toBeVisible();

  // Typed badly, on purpose. Trigram search is here for exactly this.
  await page.getByLabel(/catalogue does not have/i).fill('sprited away');
  // Scoped to the suggestion box: the board card carries an upvote control for the same title,
  // and the assertion is that *this* one works.
  const suggestion = page
    .locator('div')
    .filter({ hasText: /already on the board/i })
    .last();
  await expect(suggestion).toBeVisible();

  // Upvoting from the suggestion is the point: knowing it exists is useless without acting on it.
  await suggestion.getByRole('button', { name: /^Upvote Spirited Away/i }).click();
  await expect(suggestion.getByRole('button', { name: /1 upvotes/i })).toBeVisible();

  // And no second entry was created.
  await expect(page.getByRole('heading', { name: 'Spirited Away' })).toHaveCount(1);
});
