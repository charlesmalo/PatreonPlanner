import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { NotificationSettings } from './NotificationSettings';
import { creator, fakeApi } from '../test-support';

const PREFS = 'GET /api/v1/creators/ada-writes/notification-preferences';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/c/ada-writes/notifications']}>
      <Routes>
        <Route path="/c/:slug/notifications" element={<NotificationSettings />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NotificationSettings', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const routes = (prefs: object) => ({
    'GET /api/v1/creators/ada-writes': creator,
    [PREFS]: prefs,
  });

  const premium = {
    statuses: ['ACTIVE', 'COMPLETED'],
    themeIds: [],
    isDefault: true,
    canCustomise: true,
    emailDigest: false,
  };
  const THEMES = 'GET /api/v1/creators/ada-writes/themes';
  const themes = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Anime' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Documentary' },
  ];

  it('shows which moves reach you, and says when that is the default', async () => {
    // "I have not chosen" and "I chose exactly the default" must not render identically, or the
    // page invites someone to re-pick what they already have.
    global.fetch = fakeApi(routes(premium));
    renderPage();

    expect(await screen.findByRole('checkbox', { name: /now playing/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /suggestions/i })).not.toBeChecked();
    expect(screen.getByText(/using the default/i)).toBeInTheDocument();
  });

  it('sends the whole set when one box changes', async () => {
    const calls: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        calls.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      const path = new URL(String(input), 'http://localhost').pathname;
      const body = path.endsWith('/notification-preferences') ? premium : creator;
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    renderPage();

    await userEvent.click(await screen.findByRole('checkbox', { name: /accepted/i }));

    // Both sets, not a delta on either: the API replaces outright, so sending only the one that
    // changed would silently clear the other.
    await waitFor(() =>
      expect(calls).toEqual([{ statuses: ['ACTIVE', 'COMPLETED', 'ACCEPTED'], themeIds: [] }]),
    );
  });

  it('disables the controls for a free reader and says why', async () => {
    // Hidden would teach nothing. This is the one place premium is visible, and unlike the
    // EDIT_ENTRIES controls in the link review UI, this reader is eligible to buy the thing.
    global.fetch = fakeApi(routes({ ...premium, canCustomise: false }));
    renderPage();

    expect(await screen.findByRole('checkbox', { name: /now playing/i })).toBeDisabled();
    expect(screen.getByText(/premium/i)).toBeInTheDocument();
  });

  it('silences a board in one action and says what it did', async () => {
    global.fetch = fakeApi({
      ...routes(premium),
      'PUT /api/v1/creators/ada-writes/notification-preferences': {
        statuses: [],
        isDefault: false,
        canCustomise: true,
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /turn all of these off/i }));

    expect(await screen.findByText(/nothing from this board/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /now playing/i })).not.toBeChecked();
  });

  it('explains a refusal rather than crashing', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      [PREFS]: new Error('404'),
    });
    renderPage();

    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it('offers the board’s own themes to narrow by', async () => {
    global.fetch = fakeApi({ ...routes(premium), [THEMES]: { items: themes } });
    renderPage();

    expect(await screen.findByRole('checkbox', { name: /anime/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /documentary/i })).toBeInTheDocument();
  });

  it('says narrowing costs you the entries that have no theme', async () => {
    // Themes hang off a catalogue title, so an external link or a hand-typed name carries none.
    // A reader who narrows stops hearing about those entirely, and finding that out from silence
    // is worse than being told.
    global.fetch = fakeApi({
      ...routes({ ...premium, themeIds: [themes[0].id], isDefault: false }),
      [THEMES]: { items: themes },
    });
    renderPage();

    expect(
      await screen.findByText(/no theme of their own will not reach you/i),
    ).toBeInTheDocument();
  });

  it('says an empty choice means everything rather than nothing', async () => {
    global.fetch = fakeApi({ ...routes(premium), [THEMES]: { items: themes } });
    renderPage();

    expect(await screen.findByText(/everything on this board/i)).toBeInTheDocument();
  });

  it('sends both sets when a theme changes', async () => {
    const calls: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if ((init?.method ?? 'GET') === 'PUT') {
        calls.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      if (path.endsWith('/themes')) {
        return { ok: true, status: 200, json: async () => ({ items: themes }) } as Response;
      }
      if (path.endsWith('/notification-preferences')) {
        return { ok: true, status: 200, json: async () => premium } as Response;
      }
      return { ok: true, status: 200, json: async () => creator } as Response;
    });
    renderPage();

    await userEvent.click(await screen.findByRole('checkbox', { name: /anime/i }));

    await waitFor(() =>
      expect(calls).toEqual([{ statuses: ['ACTIVE', 'COMPLETED'], themeIds: [themes[0].id] }]),
    );
  });

  it('does not offer theme controls to a reader who may not customise', async () => {
    global.fetch = fakeApi({
      ...routes({ ...premium, canCustomise: false }),
      [THEMES]: { items: themes },
    });
    renderPage();

    expect(await screen.findByRole('checkbox', { name: /anime/i })).toBeDisabled();
  });

  it('says why the daily email is off unless asked for', async () => {
    // The address came from Patreon so they could sign in. Saying so is the difference between a
    // setting and a surprise.
    global.fetch = fakeApi(routes(premium));
    renderPage();

    expect(await screen.findByText(/came from Patreon so you could sign in/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /one email a day/i })).not.toBeChecked();
  });

  it('puts a column back when the server refuses that change too', async () => {
    // The same optimistic-then-reconciled rule as the digest switch, and it had no test: a
    // mutation removing this rollback broke nothing, which is how it was found.
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        return { ok: false, status: 402, json: async () => ({}) } as Response;
      }
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/notification-preferences')) {
        return { ok: true, status: 200, json: async () => premium } as Response;
      }
      return { ok: true, status: 200, json: async () => creator } as Response;
    });
    renderPage();

    await userEvent.click(await screen.findByRole('checkbox', { name: /accepted/i }));

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /accepted/i })).not.toBeChecked(),
    );
  });

  it('turns the daily email on', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if ((init?.method ?? 'GET') === 'PUT') {
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      if (path.endsWith('/notification-preferences')) {
        return { ok: true, status: 200, json: async () => premium } as Response;
      }
      return { ok: true, status: 200, json: async () => creator } as Response;
    });
    renderPage();

    await userEvent.click(await screen.findByRole('checkbox', { name: /one email a day/i }));

    await waitFor(() =>
      expect(calls).toEqual([{ path: '/api/v1/me/email-digest', body: { enabled: true } }]),
    );
  });

  it('puts the switch back if the server refuses', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/notification-preferences')) {
        return { ok: true, status: 200, json: async () => premium } as Response;
      }
      return { ok: true, status: 200, json: async () => creator } as Response;
    });
    renderPage();

    await userEvent.click(await screen.findByRole('checkbox', { name: /one email a day/i }));

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /one email a day/i })).not.toBeChecked(),
    );
  });
});
