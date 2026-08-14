import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SimilarEntries } from './SimilarEntries';
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

  it('debounces rather than asking on every keystroke', async () => {
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes/recommendations/similar': match,
    });
    global.fetch = fetchMock;
    const { rerender } = render(
      <SimilarEntries slug="ada-writes" query="sp" canUpvote onCount={vi.fn()} />,
    );
    for (const q of ['spi', 'spir', 'spiri', 'spirit']) {
      rerender(<SimilarEntries slug="ada-writes" query={q} canUpvote onCount={vi.fn()} />);
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.length).toBeLessThan(3);
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
