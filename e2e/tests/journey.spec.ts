import { expect, test } from '@playwright/test';
import {
  CREATOR,
  forgetAllSessions,
  resetRateLimits,
  clearAbuse,
  clearIntelligence,
  clearReaderState,
  clearStaff,
  clearReactions,
  clearPremium,
  clearTickets,
  setTierWeights,
  makeOwner,
  makeStaff,
  seedCreator,
  seedSecondBoard,
  makePremium,
  supports,
  OTHER_CREATOR,
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
  clearReaderState();
  clearTickets();
  clearReactions();
  // Every test starts from the same state regardless of what ran before, including CI retries.
  resetRateLimits();
  // Premium outlives a run; without this the second run of the suite starts with a reader who
  // is already premium and the palette test fails for a reason nowhere near itself.
  clearPremium();
});

async function signIn(
  page: import('@playwright/test').Page,
  patronCents?: number,
  patreonUserId = 'patreon-user-e2e',
  tierId = 'tier-e2e',
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
            tierIds: [tierId],
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

async function signOut(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByRole('link', { name: /sign in with patreon/i })).toBeVisible();
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

  // The card changes column; the columns themselves stay put. A kanban whose columns vanish when
  // they empty loses its shape, and there is nowhere left to move the next card to.
  const accepted = page.getByRole('region', { name: /^accepted/i });
  const suggestions = page.getByRole('region', { name: /suggestions/i });
  await expect(accepted.getByText('Princess Mononoke')).toBeVisible();
  await expect(suggestions.getByText('Princess Mononoke')).toHaveCount(0);
  await expect(suggestions.getByText(/nothing suggested yet/i)).toBeVisible();
});

test('a creator pick leads its column whatever the sort', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Laputa', 'PENDING');
  seedEntryFrom('patreon-other-e2e', 'Ponyo', 'PENDING');
  await signIn(page, 500, 'patreon-pick-e2e');
  makeStaff('patreon-pick-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  const suggestions = page.getByRole('region', { name: /suggestions/i });
  await suggestions.getByRole('button', { name: /pick “Ponyo”/i }).click();
  await expect(suggestions.getByRole('button', { name: /unpick “Ponyo”/i })).toBeVisible();

  await page.reload();
  // Survives a reload because the server holds it, and leads whichever way the column is sorted.
  for (const sort of ['Newest', 'Oldest']) {
    await page.getByLabel(/sort suggestions/i).selectOption({ label: sort });
    // Level 3: the column's own name is a heading too, and it is always first.
    await expect(suggestions.getByRole('heading', { level: 3 }).first()).toHaveText('Ponyo');
  }
});

test('a patron sees what their votes are worth and lifts them after upgrading', async ({
  page,
}) => {
  seedEntryFrom('patreon-other-e2e', 'Totoro');
  setTierWeights({ 'tier-e2e': 2, 'tier-e2e-big': 20 });
  await signIn(page, 500, 'patreon-voter-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  // The upvote control names its entry without quoting it, unlike the report control.
  await page.getByRole('button', { name: /upvote Totoro/i }).click();

  await page.getByRole('link', { name: /your votes/i }).click();
  await page.waitForURL((url) => url.pathname.endsWith('/my-votes'));
  // Scoped to the row: the sentence above it also says what the reader's tier is currently worth.
  const vote = page.getByRole('listitem').filter({ hasText: 'Totoro' });
  await expect(vote).toContainText('worth 2');
  // Nothing to lift while the tier has not changed.
  await expect(page.getByRole('button', { name: /bring them up to date/i })).toBeHidden();

  // Upgrade, and sign in again so the new tier is synced from Patreon.
  await signOut(page);
  await signIn(page, 2000, 'patreon-voter-e2e', 'tier-e2e-big');
  await page.goto(`/c/${CREATOR.slug}/my-votes`);

  await page.getByRole('button', { name: /bring them up to date/i }).click();
  await expect(page.getByText(/updated 1 vote/i)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Totoro' })).toContainText('worth 20');
});

test('an owner narrows what a moderator may do, and the board obeys', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Laputa');
  await signIn(page, 500, 'patreon-limited-e2e');
  makeStaff('patreon-limited-e2e');
  await signOut(page);

  // The owner takes away report handling, leaving everything else.
  await signIn(page, 500, 'patreon-user-e2e');
  makeOwner('patreon-user-e2e');
  await page.goto(`/c/${CREATOR.slug}/staff`);
  const row = page.getByRole('listitem').filter({ hasText: /MOD/ });
  // A plain click, not uncheck(): the control disables itself while the request is in flight, and
  // uncheck() retries against a moving target rather than waiting for it to settle.
  const reports = row.getByRole('checkbox', { name: /handle reports/i });
  await expect(reports).toBeChecked();
  await reports.click();
  await expect(reports).not.toBeChecked();
  await signOut(page);

  await signIn(page, 500, 'patreon-limited-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  // Still a moderator — the queue is still theirs to open.
  await expect(page.getByRole('link', { name: /review queue/i })).toBeVisible();
  // But the one power that was taken away is gone: moving entries still works.
  await expect(page.getByRole('button', { name: /move “Laputa”/i })).toBeVisible();
});

test('a moderator looks at their own board as a patron sees it', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Ponyo');
  await signIn(page, 500, 'patreon-viewas-e2e');
  makeStaff('patreon-viewas-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByRole('button', { name: /move “Ponyo”/i })).toBeVisible();

  await page.getByLabel(/viewing as/i).selectOption('patron');

  await expect(page.getByText(/viewing as a/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /move “Ponyo”/i })).toBeHidden();
  // Still a patron's board, not a broken one: reading and upvoting are untouched.
  await expect(page.getByRole('button', { name: /upvote Ponyo/i })).toBeVisible();

  // Survives a reload, since it is the reader's own choice about this board.
  await page.reload();
  await expect(page.getByLabel(/viewing as/i)).toHaveValue('patron');

  await page.getByLabel(/viewing as/i).selectOption('moderator');
  await expect(page.getByRole('button', { name: /move “Ponyo”/i })).toBeVisible();
});

test('a patron disputes an entry and a moderator answers', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Re Zero');
  await signIn(page, 500, 'patreon-tickets-mod-e2e');
  makeStaff('patreon-tickets-mod-e2e');
  await signOut(page);

  await signIn(page, 500, 'patreon-disputer-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await page
    .getByLabel(/message the moderators/i)
    .fill('This is season 3, not a duplicate of season 1.');
  await page.getByRole('button', { name: /^send$/i }).click();
  await expect(page.getByText(/a moderator will take a look/i)).toBeVisible();
  await signOut(page);

  await signIn(page, 500, 'patreon-tickets-mod-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByRole('link', { name: /^messages$/i }).click();
  await page.waitForURL((url) => url.pathname.endsWith('/tickets'));

  const ticket = page.getByRole('listitem').filter({ hasText: /season 3/ });
  await expect(ticket).toBeVisible();
  await ticket.getByRole('radio', { name: /^confirm$/i }).check();
  await ticket.getByRole('button', { name: /send reply/i }).click();

  // It leaves the open list, and is findable among the resolved.
  await expect(page.getByText(/nothing here/i)).toBeVisible();
  await page.getByLabel(/show/i).selectOption('RESOLVED');
  await expect(page.getByText(/season 3/)).toBeVisible();

  // And the reader is told.
  await signOut(page);
  await signIn(page, 500, 'patreon-disputer-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByRole('button', { name: /1 unread notification/i })).toBeVisible();
});

test('a patron reacts to an entry without moving it up the board', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Nausicaa', 'PENDING');
  seedEntryFrom('patreon-other-e2e', 'Porco Rosso', 'PENDING');
  await signIn(page, 500, 'patreon-reactor-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  // Upvote the *other* entry, so ranking and enthusiasm point in opposite directions.
  await page.getByRole('button', { name: /upvote Porco Rosso/i }).click();
  const nausicaa = page.getByRole('listitem').filter({ hasText: 'Nausicaa' });
  await nausicaa.getByRole('button', { name: /🔥 0 on Nausicaa/ }).click();
  await expect(nausicaa.getByRole('button', { name: /🔥 1 on Nausicaa/ })).toBeVisible();

  await page.reload();

  // Stored, not merely optimistic.
  const suggestions = page.getByRole('region', { name: /suggestions/i });
  await expect(suggestions.getByRole('button', { name: /🔥 1 on Nausicaa/ })).toBeVisible();
  // And it has not moved: the upvoted entry still leads. Enthusiasm is not demand.
  await expect(suggestions.getByRole('heading', { level: 3 }).first()).toHaveText('Porco Rosso');
});

test('the premium half of the palette is offered only to a premium reader', async ({ page }) => {
  // The seam only this can prove: the session flag reaching the reaction bar through the board
  // and the card. Both halves are unit-tested; neither says they are wired to each other.
  seedEntryFrom('patreon-other-e2e', 'Ponyo', 'PENDING');
  await signIn(page, 500, 'patreon-palette-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  const card = page.getByRole('listitem').filter({ hasText: 'Ponyo' });
  await expect(card.getByRole('button', { name: /🔥 0 on Ponyo/ })).toBeVisible();
  // A premium emote is not offered at all until somebody has used it.
  await expect(card.getByRole('button', { name: /🍿/ })).toHaveCount(0);

  makePremium('patreon-palette-e2e');
  await page.reload();

  const withPremium = page.getByRole('listitem').filter({ hasText: 'Ponyo' });
  await expect(withPremium.getByRole('button', { name: /🍿 0 on Ponyo/ })).toBeEnabled();
});

test('a moderator arranges a column by hand and it stays arranged', async ({ page }) => {
  // Playwright's dragTo drives real pointer events, so this exercises the browser's own drag
  // machinery rather than synthetic ones — which is the half a unit test cannot reach.
  seedEntryFrom('patreon-other-e2e', 'Alpha');
  seedEntryFrom('patreon-other-e2e', 'Beta');
  await signIn(page, 500, 'patreon-dragger-e2e');
  makeStaff('patreon-dragger-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  const suggestions = page.getByRole('region', { name: /suggestions/i });
  await suggestions.getByLabel(/sort suggestions/i).selectOption('manual');
  // Wait for the re-sorted list before reading it. `allTextContents` does not retry, so switching
  // sort and reading immediately races the refetch: about one run in three it returned [], every
  // `before[n]` was undefined, and `filter({ hasText: undefined })` quietly matched both cards —
  // surfacing as a strict-mode violation on the drag rather than as anything about sorting.
  const cards = suggestions.getByRole('heading', { level: 3 });
  await expect(cards).toHaveCount(2);
  const before = await cards.allTextContents();

  // Drag the second card onto the first, which places it above.
  await suggestions
    .getByRole('listitem')
    .filter({ hasText: before[1] })
    .dragTo(suggestions.getByRole('listitem').filter({ hasText: before[0] }));

  await expect(suggestions.getByRole('heading', { level: 3 }).first()).toHaveText(before[1]);

  await page.reload();
  await suggestions.getByLabel(/sort suggestions/i).selectOption('manual');

  // Stored, not merely optimistic.
  await expect(suggestions.getByRole('heading', { level: 3 }).first()).toHaveText(before[1]);
});

test('a reader folds a column away and it stays folded', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Ponyo');
  await page.goto(`/c/${CREATOR.slug}`);
  const suggestions = page.getByRole('region', { name: /suggestions/i });
  await expect(suggestions.getByText('Ponyo')).toBeVisible();

  await page.getByRole('button', { name: /collapse suggestions/i }).click();
  await expect(suggestions.getByText('Ponyo')).toBeHidden();

  await page.reload();

  // Per reader and local: it is not board configuration, so it survives a reload without ever
  // being sent to the server.
  await expect(page.getByRole('button', { name: /expand suggestions/i })).toBeVisible();
  await expect(page.getByRole('region', { name: /suggestions/i }).getByText('Ponyo')).toBeHidden();
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

test('a report reaches the moderator bell, and not the reporter own', async ({ page }) => {
  // The whole point of the notification, and it had no end-to-end cover at all: a reader is told
  // a moderator will look, so a moderator has to actually hear about it.
  seedEntryFrom('patreon-other-e2e', 'Kiki');

  // The moderator signs in first so the staff row can reference their user, and because the
  // fan-out reaches whoever is staff *at the time of the report* — someone promoted afterwards
  // finds the report in the review queue rather than in their bell.
  await signIn(page, 500, 'patreon-modbell-e2e');
  makeStaff('patreon-modbell-e2e');
  await signOut(page);

  await signIn(page, 500, 'patreon-reporter-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByRole('button', { name: /report “Kiki”/i }).click();
  await page.getByLabel(/reason/i).selectOption('SPAM');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText(/thanks/i)).toBeVisible();

  // Not the reporter: they filed it, so telling them about it is noise. Matched on the count so
  // this does not also match the "no unread" label, which is always present.
  await expect(page.getByRole('button', { name: /\d+ unread/i })).toBeHidden();

  await signOut(page);
  await signIn(page, 500, 'patreon-modbell-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  const bell = page.getByRole('button', { name: /1 unread notification/i });
  await expect(bell).toBeVisible();
  await bell.click();
  // Scoped to the notification row: the board behind the panel also has a Kiki link now that
  // card titles open their own page.
  const notification = page.getByRole('listitem').filter({ hasText: /was reported on/i });
  await expect(notification).toContainText('Kiki');

  // Opening it marks what it showed as read, so the badge clears rather than nagging for ever.
  await expect(page.getByRole('button', { name: /no unread/i })).toBeVisible();

  // Following it lands where the report can be acted on, not merely where the entry is read.
  await notification.getByRole('link').click();
  await page.waitForURL((url) => url.pathname.endsWith('/review'));
  await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
});

test('a moderator works the full notification list with filters', async ({ page }) => {
  seedEntryFrom('patreon-other-e2e', 'Laputa');
  await signIn(page, 500, 'patreon-listmod-e2e');
  makeStaff('patreon-listmod-e2e');
  await signOut(page);

  await signIn(page, 500, 'patreon-reporter2-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByRole('button', { name: /report “Laputa”/i }).click();
  await page.getByLabel(/reason/i).selectOption('HARASSMENT');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText(/thanks/i)).toBeVisible();

  await signOut(page);
  await signIn(page, 500, 'patreon-listmod-e2e');
  await page.getByRole('button', { name: /1 unread notification/i }).click();
  await page.getByRole('link', { name: /see all/i }).click();
  await page.waitForURL((url) => url.pathname === '/notifications');

  await expect(page.getByText('Laputa')).toBeVisible();
  // The reason is what the severity ranking sorts on, so it is on the row.
  await expect(page.getByText(/harassment/i)).toBeVisible();

  await page.getByLabel(/sort/i).selectOption('severity');
  await expect(page.getByText('Laputa')).toBeVisible();

  await page.getByLabel(/show/i).selectOption('ENTRY_STATUS_CHANGED');
  await expect(page.getByText(/nothing here/i)).toBeVisible();
});

test('an entry opens on its own page, and that page can be shared', async ({ page }) => {
  await signIn(page, 500, 'patreon-detail-e2e');
  seedEntryFrom('patreon-other-e2e', 'Ponyo', 'ACCEPTED');
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByRole('link', { name: 'Ponyo' }).click();
  await page.waitForURL((url) => /\/e\/[0-9a-f-]+$/.test(url.pathname));
  await expect(page.getByRole('heading', { level: 1, name: 'Ponyo' })).toBeVisible();

  // The whole point of the URL: it stands on its own, without the board having been loaded first.
  const shared = page.url();
  await page.goto('/');
  await page.goto(shared);
  await expect(page.getByRole('heading', { level: 1, name: 'Ponyo' })).toBeVisible();

  await page.getByRole('link', { name: /back to/i }).click();
  await page.waitForURL((url) => url.pathname === `/c/${CREATOR.slug}`);
});

test('a shared link to an entry nobody can see says so rather than breaking', async ({ page }) => {
  await signIn(page, 500, 'patreon-detail-e2e');
  await page.goto(`/c/${CREATOR.slug}/e/11111111-1111-4111-8111-111111111111`);

  await expect(page.getByText(/not found/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /back to/i })).toBeVisible();
});

test('a reader finds a board by name and walks to it without typing a URL', async ({ page }) => {
  // The traversal a real visitor makes: land, search, click through. Previously the only way onto
  // a board was knowing its slug and typing it.
  await signIn(page, 500, 'patreon-finder-e2e');
  await page.goto('/');

  await page.getByLabel(/find a creator/i).fill(CREATOR.displayName.slice(0, 6));
  await page.getByRole('link', { name: CREATOR.displayName }).click();

  await page.waitForURL((url) => url.pathname === `/c/${CREATOR.slug}`);
  await expect(page.getByRole('heading', { name: CREATOR.displayName })).toBeVisible();
});

test('a follower is told when a board starts something', async ({ page }) => {
  // The reason to open the app at all: finding out that a creator you follow has actually started
  // something. Proves the whole path end to end — favouriting is the follow, the move fans out to
  // followers rather than only to the submitter, and the bell is where it lands.
  seedEntryFrom('patreon-other-e2e', 'Nausicaa', 'ACCEPTED');

  // A reader who follows the board, and is not the submitter.
  await signIn(page, 500, 'patreon-follower-e2e');
  await page.goto('/');
  await page.getByLabel(/find a creator/i).fill(CREATOR.displayName.slice(0, 6));
  await page
    .getByRole('button', { name: new RegExp(`Favourite ${CREATOR.displayName}`, 'i') })
    .click();
  await expect(page.getByText(/^Favourite$/)).toBeVisible();
  await signOut(page);

  // A moderator starts it.
  await signIn(page, 500, 'patreon-movemod-e2e');
  makeStaff('patreon-movemod-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByRole('button', { name: /Move “Nausicaa” to another column/i }).click();
  await page.getByRole('menuitem', { name: 'Now Playing' }).click();
  await signOut(page);

  // And the follower hears about it.
  await signIn(page, 500, 'patreon-follower-e2e');
  await page.goto(`/c/${CREATOR.slug}`);
  await expect(page.getByRole('button', { name: /1 unread notification/i })).toBeVisible();
});

test('a favourited board is offered first next time', async ({ page }) => {
  await signIn(page, 500, 'patreon-finder-e2e');
  await page.goto('/');
  await page.getByLabel(/find a creator/i).fill(CREATOR.displayName.slice(0, 6));

  await page
    .getByRole('button', { name: new RegExp(`Favourite ${CREATOR.displayName}`, 'i') })
    .click();
  await expect(page.getByText(/^Favourite$/)).toBeVisible();

  await page.reload();
  await page.getByLabel(/find a creator/i).fill(CREATOR.displayName.slice(0, 6));

  // Survives a reload because it is stored, not held in the tab.
  await expect(page.getByText(/^Favourite$/)).toBeVisible();
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

test('a patron link waits for a moderator, who publishes it from the card', async ({ page }) => {
  // The whole shape of the feature in one pass, through the real proxy: submitting attaches a
  // link that does *not* render as the creator's own, and the control that releases it lives on
  // the card. The API-level tests prove each half; only this proves they are wired to each other.
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  await page.getByLabel(/add something the catalogue does not have/i).fill('Perfect Blue');
  await page.getByLabel(/^link/i).fill('https://example.test/perfect-blue');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();

  // Theirs, so they can see it is pending rather than think it was dropped — but not as a link.
  await expect(page.getByText(/your link is waiting for review/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://example.test/perfect-blue' })).toHaveCount(
    0,
  );

  // A moderator sees the same URL as something to decide on.
  await forgetAllSessions();
  await signIn(page, 500, 'patreon-mod-e2e');
  makeStaff('patreon-mod-e2e');
  await page.goto(`/c/${CREATOR.slug}`);

  await expect(page.getByText(/suggested links, waiting for review/i)).toBeVisible();
  await page.getByRole('button', { name: 'Publish https://example.test/perfect-blue' }).click();

  // And now it is a real link, opened without handing the page a reference back.
  const published = page.getByRole('link', { name: 'https://example.test/perfect-blue' });
  await expect(published).toBeVisible();
  await expect(published).toHaveAttribute('rel', /noopener/);
});

test('a patron carries a suggestion to another board they support', async ({ page }) => {
  // The page-to-queue path end to end. What happens to each delivery afterwards is covered by
  // twenty integration tests; what only this can prove is that the page, the endpoint and the
  // dashboard agree with each other through the real proxy.
  seedSecondBoard();
  await signIn(page, 500, 'patreon-carrier-e2e');
  makePremium('patreon-carrier-e2e');
  supports('patreon-carrier-e2e', CREATOR.id);
  supports('patreon-carrier-e2e', OTHER_CREATOR.id);

  // Something of their own to carry.
  await page.goto(`/c/${CREATOR.slug}`);
  await page.getByLabel(/add something the catalogue does not have/i).fill('Millennium Actress');
  await page.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Millennium Actress' })).toBeVisible();

  await page.goto('/carry-over');
  await page.getByRole('checkbox', { name: /Millennium Actress/ }).check();
  await page.getByRole('checkbox', { name: OTHER_CREATOR.displayName }).check();
  await page.getByRole('button', { name: /send these/i }).click();

  // Queued, and said to be queued rather than done — they drain at each board's own rate.
  await expect(page.getByText(/on the way/i)).toBeVisible();
  await expect(page.getByText(/Waiting its turn/i)).toBeVisible();
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
