import { render, screen } from '@testing-library/react';
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
});
