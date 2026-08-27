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

  const premium = { statuses: ['ACTIVE', 'COMPLETED'], isDefault: true, canCustomise: true };

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

    // The whole set, not a delta: the API replaces it, so two tabs cannot race into a merge.
    await waitFor(() => expect(calls).toEqual([{ statuses: ['ACTIVE', 'COMPLETED', 'ACCEPTED'] }]));
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
});
