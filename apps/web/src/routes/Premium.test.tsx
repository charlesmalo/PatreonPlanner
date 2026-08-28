import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Premium } from './Premium';

const renderPage = (fetchImpl: typeof global.fetch) => {
  global.fetch = fetchImpl;
  return render(
    <MemoryRouter>
      <Premium />
    </MemoryRouter>,
  );
};

const state = (body: object) =>
  vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({ url: 'https://pay.test/co' }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof global.fetch;

describe('Premium', () => {
  const originalFetch = global.fetch;
  const originalLocation = window.location;
  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('does not claim you are unsubscribed while it is still looking', async () => {
    let release: () => void = () => {};
    renderPage(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({ available: true, subscription: null }),
              } as Response);
          }),
      ) as unknown as typeof global.fetch,
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
    release();
  });

  it('offers to subscribe when nothing is held yet', async () => {
    renderPage(state({ available: true, subscription: null }));

    expect(await screen.findByRole('button', { name: /subscribe/i })).toBeInTheDocument();
  });

  it('sends the reader to the provider rather than taking a card here', async () => {
    // No payment field ever renders in this application; checkout is a hosted page on their
    // domain, which is most of what a merchant of record is for.
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true });
    renderPage(state({ available: true, subscription: null }));

    await userEvent.click(await screen.findByRole('button', { name: /subscribe/i }));

    await waitFor(() => expect(window.location.href).toBe('https://pay.test/co'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows what is held, and when it renews', async () => {
    renderPage(
      state({
        available: true,
        subscription: {
          status: 'ACTIVE',
          currentPeriodEnd: '2026-10-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
      }),
    );

    expect(await screen.findByText(/active/i)).toBeInTheDocument();
    expect(screen.getByText(/renews on/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
  });

  it('says a cancelled subscription ends rather than renews', async () => {
    // They keep everything until then. Saying "renews" would be untrue, and saying nothing would
    // leave them wondering whether cancelling worked.
    renderPage(
      state({
        available: true,
        subscription: {
          status: 'CANCELLED',
          currentPeriodEnd: '2026-10-01T00:00:00.000Z',
          cancelAtPeriodEnd: true,
        },
      }),
    );

    expect(await screen.findByText(/ends on/i)).toBeInTheDocument();
    expect(screen.getByText(/you keep everything until/i)).toBeInTheDocument();
  });

  it('explains a failed payment in terms of what to do about it', async () => {
    renderPage(
      state({
        available: true,
        subscription: {
          status: 'PAST_DUE',
          currentPeriodEnd: '2026-09-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
      }),
    );

    expect(await screen.findByText(/card may need updating/i)).toBeInTheDocument();
  });

  it('says so plainly when the instance sells nothing', async () => {
    // Self-hosted, or simply not configured. Offering a button that cannot work is a lie.
    renderPage(state({ available: false, subscription: null }));

    expect(await screen.findByText(/not available on this instance/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
  });
});
