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
    // An alert, not a status line: this one is the reason the press did nothing, and the grey
    // status text underneath the form was missed by the first person to try it.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /search for a title, or give it one yourself/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits what was typed into the search box when the catalogue found nothing', async () => {
    // The failure a playtester actually hit: they typed the title into the search field, got no
    // suggestions because the catalogue does not carry it, pressed Suggest — and the form
    // silently refused, because at submit time it only looked at the *other* title field. The
    // text was stranded in a box the submit path ignored.
    const created = recommendation({ id: 'new-2', customTitle: 'Demon Slayer' });
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/catalog/search': { results: [] },
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: false,
        recommendation: created,
      },
    });
    const onCreated = setup();

    await userEvent.type(screen.getByLabelText(/search films and shows/i), 'Demon Slayer');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  it('offers to add the typed title outright once the search comes back empty', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators/ada-writes/catalog/search': { results: [] } });
    setup();

    await userEvent.type(screen.getByLabelText(/search films and shows/i), 'Demon Slayer');

    // Said plainly, rather than leaving the reader to guess that a second field is the way in.
    expect(await screen.findByText(/nothing in the catalogue matches/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /add “Demon Slayer” anyway/i }),
    ).toBeInTheDocument();
  });

  it('moves the typed title into the free-text field when that offer is taken', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators/ada-writes/catalog/search': { results: [] } });
    setup();

    await userEvent.type(screen.getByLabelText(/search films and shows/i), 'Demon Slayer');
    await userEvent.click(
      await screen.findByRole('button', { name: /add “Demon Slayer” anyway/i }),
    );

    expect(screen.getByLabelText(/catalogue does not have/i)).toHaveValue('Demon Slayer');
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

describe('SubmitForm content classes', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function renderForm(onCreated = vi.fn()) {
    render(<SubmitForm slug="ada-writes" onCreated={onCreated} />);
  }

  it('submits a picked collection as a franchise', async () => {
    // The catalogue now returns collections; mapping mediaType straight to MOVIE would post a
    // film id as a film and bind the wrong row.
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes/catalog/search': {
        results: [
          {
            tmdbId: 10,
            mediaType: 'COLLECTION',
            name: 'Star Wars Collection',
            year: null,
            posterPath: null,
            overview: null,
          },
        ],
      },
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: false,
        recommendation: recommendation(),
      },
    });
    global.fetch = fetchMock;
    renderForm();
    await userEvent.type(screen.getByLabelText(/search films and shows/i), 'star wars');
    await userEvent.click(await screen.findByRole('button', { name: /star wars collection/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
      type: 'FRANCHISE',
      tmdbId: 10,
    });
  });

  it('submits a watch order with its steps in order', async () => {
    const fetchMock = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: false,
        recommendation: recommendation(),
      },
    });
    global.fetch = fetchMock;
    renderForm();

    await userEvent.click(screen.getByRole('radio', { name: /watch order/i }));
    await userEvent.type(screen.getByLabelText(/what to call it/i), 'Chronological Star Wars');
    await userEvent.click(screen.getByRole('button', { name: /add a step/i }));
    await userEvent.type(screen.getByLabelText('Step 1 title'), 'The Phantom Menace');
    await userEvent.click(screen.getByRole('button', { name: /add a step/i }));
    await userEvent.type(screen.getByLabelText('Step 2 title'), 'Attack of the Clones');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
      type: 'WATCH_ORDER',
      customTitle: 'Chronological Star Wars',
      items: [{ customTitle: 'The Phantom Menace' }, { customTitle: 'Attack of the Clones' }],
    });
  });

  it('blocks a watch order with no steps without a request', async () => {
    const fetchMock = fakeApi({});
    global.fetch = fetchMock;
    renderForm();
    await userEvent.click(screen.getByRole('radio', { name: /watch order/i }));
    await userEvent.type(screen.getByLabelText(/what to call it/i), 'Empty');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one step/i);
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
  });

  it('drops a blank step rather than sending it', async () => {
    const fetchMock = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations': {
        duplicate: false,
        recommendation: recommendation(),
      },
    });
    global.fetch = fetchMock;
    renderForm();
    await userEvent.click(screen.getByRole('radio', { name: /watch order/i }));
    await userEvent.type(screen.getByLabelText(/what to call it/i), 'Order');
    await userEvent.click(screen.getByRole('button', { name: /add a step/i }));
    await userEvent.type(screen.getByLabelText('Step 1 title'), 'One');
    // A second, untouched step is the natural result of clicking "Add a step" once too often.
    await userEvent.click(screen.getByRole('button', { name: /add a step/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body)).items).toEqual([{ customTitle: 'One' }]);
  });

  it('hides the catalogue search and the link field in watch-order mode', async () => {
    // The search picks a single work, and a watch order has no single work; the link field is
    // never sent for one, so leaving it visible silently drops whatever is typed there.
    renderForm();
    expect(screen.getByLabelText(/search films and shows/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /watch order/i }));
    // Unmounted rather than class-hidden: jsdom applies no stylesheet, so a `hidden` class here
    // would make the assertion meaningless.
    expect(screen.queryByLabelText(/search films and shows/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/link/i)).not.toBeInTheDocument();
  });

  it('refuses more than fifty steps without a request', async () => {
    const fetchMock = fakeApi({});
    global.fetch = fetchMock;
    renderForm();
    await userEvent.click(screen.getByRole('radio', { name: /watch order/i }));
    await userEvent.type(screen.getByLabelText(/what to call it/i), 'Long');
    // Faster than clicking "Add a step" fifty-one times, and the assertion is about the cap.
    for (let i = 0; i < 51; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: /add a step/i }));
    }
    const inputs = screen.getAllByPlaceholderText('What to watch');
    for (const input of inputs) await userEvent.type(input, 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/fifty steps/i);
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
  }, 30_000);
});

describe('SubmitForm when the user is timed out', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function timedOut(retryAt?: string) {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => (retryAt ? { message: 'no', retryAt } : { message: 'no' }),
    })) as never;
  }

  async function attempt() {
    render(<SubmitForm slug="ada-writes" onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/catalogue does not have/i), 'Anything');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
  }

  it('says when the user may suggest again', async () => {
    timedOut(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    await attempt();
    const status = await screen.findByRole('alert');
    expect(status).toHaveTextContent(/until/i);
  });

  it('says nothing about why', async () => {
    // Design §9: explaining the rule invites gaming it.
    timedOut(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    await attempt();
    expect((await screen.findByRole('alert')).textContent).not.toMatch(/strike|abuse|blocked/i);
  });

  it('falls back to the generic refusal when there is no time', async () => {
    // A 403 also means "not allowed here", which is a different thing entirely.
    timedOut();
    await attempt();
    expect(await screen.findByRole('alert')).toHaveTextContent(/for patrons at the required tier/i);
  });

  it('leaves the form in place so the user is not left wondering where it went', async () => {
    timedOut(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    await attempt();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Suggest' })).toBeInTheDocument();
  });
});
