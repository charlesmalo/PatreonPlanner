import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpvoteButton } from './UpvoteButton';
import { fakeApi } from '../test-support';

describe('UpvoteButton', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setup = (canUpvote: boolean, onCount = vi.fn(), hasUpvoted = false) => {
    render(
      <UpvoteButton
        slug="ada-writes"
        recommendationId="rec-1"
        title="Spirited Away"
        upvoteCount={3}
        hasUpvoted={hasUpvoted}
        canUpvote={canUpvote}
        onCount={onCount}
      />,
    );
    return onCount;
  };

  it('is disabled with an explanation when the viewer cannot upvote', () => {
    setup(false);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Upvoting is for patrons');
  });

  it('reports pressed state from the server, not from a local guess', () => {
    setup(true, vi.fn(), false);
    // Seeded from hasUpvoted: previously this always started false, so an entry the viewer had
    // already upvoted announced the wrong state.
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports pressed when the viewer has already upvoted', () => {
    setup(true, vi.fn(), true);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAccessibleName(/remove upvote from Spirited Away/i);
  });

  it('names each button after its suggestion', () => {
    setup(true);
    // Otherwise every button on the board is just "3 upvotes" with no clue which entry.
    expect(screen.getByRole('button')).toHaveAccessibleName(/upvote Spirited Away — 3 upvotes/i);
  });

  it('sends the optimistic direction the server state implies', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/upvote': {
        upvoted: true,
        upvoteCount: 9,
      },
    });
    const onCount = setup(true);
    await userEvent.click(screen.getByRole('button'));
    // Optimistic first, authoritative second.
    expect(onCount).toHaveBeenNthCalledWith(1, 'rec-1', 4, true);
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('rec-1', 9, true));
  });

  it('reverts and explains when the server refuses', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/upvote': new Error('403'),
    });
    const onCount = setup(true);
    await userEvent.click(screen.getByRole('button'));
    // The capability flag only chose what to render; the server is what decides.
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('rec-1', 3, false));
  });
});

describe('RecommendationCard resilience', () => {
  it('renders an entry that arrived without the board-only fields', async () => {
    // The submit response has repeatedly lagged the board projection by a field. The API test
    // now pins the shapes together; this makes the failure a missing chip rather than a blank
    // page if they ever drift again.
    const { RecommendationCard } = await import('./RecommendationCard');
    const { recommendation } = await import('../test-support');
    const entry = recommendation();
    delete (entry as Partial<typeof entry>).themes;

    render(
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={entry}
          canUpvote
          canModerate={false}
          onCount={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText('Spirited Away')).toBeInTheDocument();
  });
});
