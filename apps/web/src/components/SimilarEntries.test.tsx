import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEBOUNCE_MS, SimilarEntries } from './SimilarEntries';
import { fakeApi, recommendation } from '../test-support';

function renderIt(query: string, onCount = vi.fn()) {
  render(<SimilarEntries slug="ada-writes" query={query} canUpvote onCount={onCount} />);
}

describe('SimilarEntries', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const match = { items: [recommendation({ id: 'existing', customTitle: 'Spirited Away' })] };

  it('asks nothing below the minimum query length', async () => {
    const fetchMock = fakeApi({});
    global.fetch = fetchMock;
    renderIt('a');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers a match with an upvote control, not just a name', async () => {
    // "It is already there" is useless without "so upvote it" — that is the whole point of
    // surfacing this before someone submits a duplicate.
    global.fetch = fakeApi({ 'GET /api/v1/creators/ada-writes/recommendations/similar': match });
    renderIt('sprited away');
    expect(await screen.findByText('Spirited Away')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upvote/i })).toBeInTheDocument();
  });

  it('reflects an upvote in its own list, not only in the board', async () => {
    // UpvoteButton renders from its props: without updating this list's copy the count springs
    // back on reconcile, and the control looks broken exactly where it is meant to be useful.
    const onCount = vi.fn();
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/recommendations/similar': match,
      'POST /api/v1/creators/ada-writes/recommendations/existing/upvote': {
        upvoted: true,
        upvoteCount: 4,
      },
    });
    renderIt('sprited away', onCount);
    await userEvent.click(await screen.findByRole('button', { name: /^Upvote Spirited Away/i }));

    expect(
      await screen.findByRole('button', { name: /Remove upvote from Spirited Away — 4 upvotes/i }),
    ).toBeInTheDocument();
    expect(onCount).toHaveBeenCalledWith('existing', 4, true);
  });

  it('renders nothing when there are no matches, rather than an empty box', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/recommendations/similar': { items: [] },
    });
    const { container } = render(
      <SimilarEntries slug="ada-writes" query="nothing like this" canUpvote onCount={vi.fn()} />,
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the lookup fails', async () => {
    // This is an aid, not the task. An error here would interrupt someone mid-submission for
    // something they did not ask for.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/recommendations/similar': new Error('500'),
    });
    const { container } = render(
      <SimilarEntries slug="ada-writes" query="anything" canUpvote onCount={vi.fn()} />,
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('waits the full debounce interval before asking', async () => {
    // Asserted at the boundary with fake timers: counting calls across synchronous rerenders
    // only proves the effect cleanup runs, and passed with the interval set to zero.
    vi.useFakeTimers();
    try {
      const fetchMock = fakeApi({
        'GET /api/v1/creators/ada-writes/recommendations/similar': match,
      });
      global.fetch = fetchMock;
      render(<SimilarEntries slug="ada-writes" query="spirited" canUpvote onCount={vi.fn()} />);

      vi.advanceTimersByTime(DEBOUNCE_MS - 50);
      expect(fetchMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a title containing markup as text', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/recommendations/similar': {
        items: [recommendation({ id: 'x', customTitle: '<img src=x>' })],
      },
    });
    const { container } = render(
      <SimilarEntries slug="ada-writes" query="anything" canUpvote onCount={vi.fn()} />,
    );
    expect(await screen.findByText('<img src=x>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
