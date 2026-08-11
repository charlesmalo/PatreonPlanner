import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubmitForm } from './SubmitForm';
import { fakeApi, recommendation } from '../test-support';

describe('SubmitForm', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setup = (onCreated = vi.fn()) => {
    render(<SubmitForm slug="ada-writes" onCreated={onCreated} />);
    return onCreated;
  };

  it('labels every field', () => {
    setup();
    expect(screen.getByLabelText(/search films and shows/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/catalogue does not have/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/why\?/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^link/i)).toBeInTheDocument();
  });

  it('blocks an empty title without a request', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(
      await screen.findByText(/search for a title, or give it one yourself/i),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the entry and hands it back', async () => {
    const created = recommendation({ id: 'new-1', customTitle: 'Akira' });
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: false,
        recommendation: created,
      },
    });
    const onCreated = setup();

    await userEvent.type(screen.getByLabelText(/catalogue does not have/i), 'Akira');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(await screen.findByText(/pending review/i)).toBeInTheDocument();
    // Cleared, so a second suggestion does not resubmit the first.
    expect(screen.getByLabelText(/catalogue does not have/i)).toHaveValue('');
  });

  it('searches the catalogue after a debounce and binds the picked title', async () => {
    const created = recommendation({ id: 'new-2', customTitle: 'Spirited Away' });
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes/catalog/search': {
        results: [
          {
            tmdbId: 129,
            mediaType: 'MOVIE',
            name: 'Spirited Away',
            year: 2001,
            posterPath: '/p.jpg',
            overview: null,
          },
        ],
      },
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: false,
        recommendation: created,
      },
    });
    global.fetch = fetchMock;
    setup();

    await userEvent.type(screen.getByLabelText(/search films and shows/i), 'spirited');
    const option = await screen.findByRole('button', { name: /spirited away \(2001\)/i });
    await userEvent.click(option);

    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      // The canonical name comes from the catalogue, so none is sent.
      expect(JSON.parse((submitCall?.[1] as RequestInit).body as string)).toEqual({
        type: 'MOVIE',
        tmdbId: 129,
      });
    });
  });

  it('lets the reader fall back to a free-text link when the catalogue fails', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/catalog/search': new Error('502'),
    });
    setup();
    await userEvent.type(screen.getByLabelText(/search films and shows/i), 'anything');
    // Design §5: no match means refine or switch to an external link, not a dead end.
    expect(await screen.findByText(/still add a link below/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/catalogue does not have/i)).toBeVisible();
  });

  it('explains a duplicate instead of pretending it was added', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: true,
        recommendation: recommendation(),
      },
    });
    setup();
    await userEvent.type(screen.getByLabelText(/catalogue does not have/i), 'Spirited Away');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(/already on the board/i)).toBeInTheDocument();
  });

  it.each([
    [429, /try again a little later/i],
    [400, /rejected/i],
    [403, /for patrons at the required tier/i],
  ])('explains a %i from the server', async (status, expected) => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations': new Error(String(status)),
    });
    setup();
    await userEvent.type(screen.getByLabelText(/catalogue does not have/i), 'Something');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});
