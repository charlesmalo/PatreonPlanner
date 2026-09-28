import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecommendationCard } from './RecommendationCard';
import { recommendation } from '../test-support';
import type { Recommendation, StaffPermission } from '../api/types';

const candidate = { id: 'l1', url: 'https://example.test/a', label: null, isPreferred: false };

function renderCard(entry: Recommendation, permissions: StaffPermission[] = [], moderate = false) {
  return render(
    <MemoryRouter>
      <ul>
        <RecommendationCard
          slug="ada-writes"
          recommendation={entry}
          canUpvote={false}
          canModerate={moderate}
          permissions={permissions}
          onCount={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      </ul>
    </MemoryRouter>,
  );
}

describe('RecommendationCard link candidates', () => {
  it('shows a waiting candidate to staff, with controls', () => {
    // The seam the component's own tests cannot cover: that the card threads `candidateLinks`
    // and `permissions` down at all. Both were added in the same change, and either one left
    // unwired renders an empty strip that looks exactly like "no candidates".
    renderCard(recommendation({ candidateLinks: [candidate] }), ['EDIT_ENTRIES'], true);

    expect(screen.getByText(/suggested links, waiting for review/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /publish/i })).toBeInTheDocument();
  });

  it('shows a submitter their own waiting link, without controls', () => {
    renderCard(recommendation({ candidateLinks: [candidate] }));

    expect(screen.getByText(/your link is waiting/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
  });

  it('draws nothing when there are no candidates', () => {
    renderCard(recommendation());
    expect(screen.queryByText(/waiting for review/i)).not.toBeInTheDocument();
  });

  it('survives an entry with no candidateLinks key at all', () => {
    // A card renders from both the board projection and a submit response. A shape mismatch
    // between them should cost this strip, not the page — the same reason `themes` is guarded.
    const entry = recommendation();
    delete (entry as Partial<Recommendation>).candidateLinks;

    renderCard(entry, ['EDIT_ENTRIES'], true);

    expect(screen.getByText('Spirited Away')).toBeInTheDocument();
  });

  it('offers Move only to a moderator who may actually move things', async () => {
    // The API requires MOVE_ENTRIES on every status endpoint. A moderator without it — which is
    // what an invite grants until the creator says otherwise — saw the control, pressed it, and
    // got a 403 with the entry silently staying put. The capabilities payload exists precisely so
    // the client can tell these moderators apart; this control was not using it.
    renderCard(recommendation(), ['HANDLE_REPORTS'], true);

    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
  });

  it('offers Move to a moderator who holds MOVE_ENTRIES', async () => {
    renderCard(recommendation(), ['MOVE_ENTRIES'], true);

    expect(screen.getByRole('button', { name: /^Move/ })).toBeInTheDocument();
  });

  it('offers Pick only to a moderator who may move things', async () => {
    // `pick` is a MOVE_ENTRIES endpoint like the status ones, so it is offered on the same terms.
    renderCard(recommendation(), ['HANDLE_REPORTS'], true);
    expect(screen.queryByRole('button', { name: /pick/i })).not.toBeInTheDocument();

    cleanup();
    renderCard(recommendation(), ['MOVE_ENTRIES'], true);
    expect(screen.getByRole('button', { name: /pick/i })).toBeInTheDocument();
  });
});

describe('RecommendationCard redeems', () => {
  function renderRedeemable(entry: Recommendation, tokensAvailable = 2) {
    return render(
      <MemoryRouter>
        <ul>
          <RecommendationCard
            slug="ada-writes"
            recommendation={entry}
            canUpvote={false}
            canModerate={false}
            onCount={vi.fn()}
            onStatusChanged={vi.fn()}
            tokensAvailable={tokensAvailable}
            onRedeemed={vi.fn()}
          />
        </ul>
      </MemoryRouter>,
    );
  }

  it('offers the redeem control on an accepted entry', () => {
    renderRedeemable(recommendation({ status: 'ACCEPTED' }));

    expect(screen.getByRole('button', { name: /redeem a token/i })).toBeInTheDocument();
  });

  it('hides the redeem control on an entry that is not accepted', () => {
    // The API refuses a redeem on anything but ACCEPTED. Drawing the button on a pending entry
    // spends the reader's attention on a control whose only possible answer is 409.
    for (const status of ['PENDING', 'ACTIVE', 'COMPLETED', 'REJECTED'] as const) {
      renderRedeemable(recommendation({ status }));
      expect(screen.queryByRole('button', { name: /redeem a token/i })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('hides the redeem control where nothing can handle the result', () => {
    // Search hits and an entry's own page pass no `onRedeemed`. Spending a token there would
    // succeed on the server and leave the screen showing the old state.
    render(
      <MemoryRouter>
        <ul>
          <RecommendationCard
            slug="ada-writes"
            recommendation={recommendation({ status: 'ACCEPTED' })}
            canUpvote={false}
            canModerate={false}
            onCount={vi.fn()}
            onStatusChanged={vi.fn()}
            tokensAvailable={2}
          />
        </ul>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: /redeem a token/i })).not.toBeInTheDocument();
  });

  it('marks an entry somebody has spent a token on, with how many', () => {
    // The count carries the weight: three readers spending on one entry is a different signal
    // from one, and the board orders on exactly that number.
    renderRedeemable(recommendation({ status: 'ACCEPTED', unconsumedRedeems: 3 }));

    expect(screen.getByText(/priority · 3/i)).toBeInTheDocument();
  });

  it('marks nothing on an entry nobody has redeemed', () => {
    renderRedeemable(recommendation({ status: 'ACCEPTED', unconsumedRedeems: 0 }));

    expect(screen.queryByText(/priority/i)).not.toBeInTheDocument();
  });
});
