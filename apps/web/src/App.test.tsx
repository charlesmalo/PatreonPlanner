import { render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { fakeApi } from './test-support';

/**
 * The route table, which was 33 statements at 0% coverage — no test file — and passed under the
 * global gate like the other two.
 *
 * Every page it mounts is tested on its own, so this asserts only what App itself decides and
 * nothing else can: that an unrecognised URL says so instead of rendering a blank shell, and the
 * two things it derives from the session — whether the landing page offers the creator's way in,
 * and whether the notification badge polls at all.
 *
 * That second one is the reason this file is worth a test rather than a smoke check. Polling is
 * started from `user !== null`, so a wrong answer means every signed-out visitor's browser asks a
 * session-only endpoint on a timer, forever, and the only visible symptom is nothing at all.
 */
describe('App', () => {
  const originalFetch = global.fetch;

  // `window.location` is left alone on purpose: `BrowserRouter` reads its origin, and the stub
  // the hook tests use — an object carrying only `assign` — makes every route here fail to
  // resolve. Nothing in this file signs out, which is the only thing that calls `assign`.
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.history.pushState({}, '', '/');
  });

  const signedIn = () =>
    fakeApi({
      'GET /api/v1/me': { id: 'u1', patreonUserId: 'p1', fullName: 'Ada', avatarUrl: null },
      'GET /api/v1/notifications/unread-count': { count: 0 },
    });

  // 401 is how the API says "nobody is signed in"; `fakeApi` turns an Error into that status.
  const signedOut = () => fakeApi({ 'GET /api/v1/me': new Error('401') });

  it('says so on a URL that matches no route', async () => {
    global.fetch = signedOut();
    window.history.pushState({}, '', '/nothing-here');
    render(<App />);

    expect(await screen.findByText(/page not found/i)).toBeInTheDocument();
  });

  it('mounts the single-message page a ticket notification links to', async () => {
    // App is the only thing that can be wrong about this. Every link to that URL is built
    // elsewhere, and an unregistered path renders "Page not found" with nothing failing — which
    // is exactly how `payload.ticketId` pointed at nothing for as long as it did.
    global.fetch = fakeApi({
      'GET /api/v1/me': new Error('401'),
      'GET /api/v1/creators/ada-writes': new Error('404'),
      'GET /api/v1/creators/ada-writes/capabilities': new Error('404'),
      'GET /api/v1/creators/ada-writes/tickets/tk1': new Error('404'),
    });
    window.history.pushState({}, '', '/c/ada-writes/tickets/tk1');
    render(<App />);

    // The page's own not-found heading, not the route table's fallback paragraph.
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(screen.queryByText(/page not found/i)).not.toBeInTheDocument();
  });

  it('hands the landing page a session, so a signed-in reader is offered a board', async () => {
    global.fetch = signedIn();
    render(<App />);

    expect(await screen.findByRole('link', { name: /create a board for it/i })).toBeInTheDocument();
  });

  it('tells the landing page there is no session, so the offer is withheld', async () => {
    global.fetch = signedOut();
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Pitch.');
    expect(screen.queryByRole('link', { name: /create a board for it/i })).not.toBeInTheDocument();
  });

  it('polls the unread count once there is a session', async () => {
    const fetch = signedIn();
    global.fetch = fetch;
    render(<App />);

    await waitFor(() => {
      expect(
        fetch.mock.calls.some(([input]) => String(input).includes('/notifications/unread-count')),
      ).toBe(true);
    });
  });

  it('never asks for the unread count with nobody signed in', async () => {
    const fetch = signedOut();
    global.fetch = fetch;
    render(<App />);

    // Wait for the session to settle first, or this passes before anything could have polled.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Pitch.');
    expect(
      fetch.mock.calls.some(([input]) => String(input).includes('/notifications/unread-count')),
    ).toBe(false);
  });
});
