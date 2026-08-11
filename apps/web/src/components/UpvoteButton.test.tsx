import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpvoteButton } from './UpvoteButton';
import { fakeApi } from '../test-support';

describe('UpvoteButton', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setup = (canUpvote: boolean, onCount = vi.fn()) => {
    render(
      <UpvoteButton
        slug="ada-writes"
        recommendationId="rec-1"
        upvoteCount={3}
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

  it('reports pressed state for assistive technology', async () => {
    global.fetch = fakeApi({ '/upvote': { upvoted: true, upvoteCount: 4 } });
    setup(true);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
  });

  it('updates optimistically, then reconciles to the server count', async () => {
    global.fetch = fakeApi({ '/upvote': { upvoted: true, upvoteCount: 9 } });
    const onCount = setup(true);
    await userEvent.click(screen.getByRole('button'));
    // Optimistic first, authoritative second.
    expect(onCount).toHaveBeenNthCalledWith(1, 'rec-1', 4);
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('rec-1', 9));
  });

  it('reverts and explains when the server refuses', async () => {
    global.fetch = fakeApi({ '/upvote': new Error('403') });
    const onCount = setup(true);
    await userEvent.click(screen.getByRole('button'));
    // The capability flag only chose what to render; the server is what decides.
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('rec-1', 3));
  });
});
