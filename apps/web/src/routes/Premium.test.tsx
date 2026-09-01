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

/**
 * Routed by URL rather than answering everything with one body: the page now makes two reads, and
 * a stub that returns the subscription shape for the receipts call would let the page pass while
 * reading the wrong thing.
 */
const state = (body: object, receipts: object[] = []) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({ url: 'https://pay.test/co' }),
      } as Response;
    }
    if (String(input).includes('/billing/receipts')) {
      return { ok: true, status: 200, json: async () => ({ receipts }) } as Response;
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

  describe('receipts', () => {
    const subscribed = {
      available: true,
      subscription: {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
      },
    };

    it('lists what the reader has paid', async () => {
      renderPage(
        state(subscribed, [
          {
            id: 'r1',
            providerReceiptId: 'rcp_1',
            amountCents: 500,
            currency: 'USD',
            paidAt: '2026-08-01T00:00:00.000Z',
            url: null,
          },
        ]),
      );

      expect(await screen.findByText(/\$5\.00/)).toBeInTheDocument();
    });

    it('links to the provider-hosted one when there is one', async () => {
      renderPage(
        state(subscribed, [
          {
            id: 'r1',
            providerReceiptId: 'rcp_1',
            amountCents: 500,
            currency: 'USD',
            paidAt: '2026-08-01T00:00:00.000Z',
            url: 'https://pay.test/receipt/1',
          },
        ]),
      );

      const link = await screen.findByRole('link', { name: /receipt/i });
      expect(link).toHaveAttribute('href', 'https://pay.test/receipt/1');
    });

    it('says nothing at all when there are none, rather than showing an empty table', async () => {
      renderPage(state(subscribed, []));

      // Waits for the page to settle first, so this cannot pass merely by being early.
      await screen.findByText(/Renews on/);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('still renders the subscription when the receipts call fails', async () => {
      // Payment history is the least important thing on this page. Losing it must not take the
      // renewal date with it.
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/billing/receipts')) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return { ok: true, status: 200, json: async () => subscribed } as Response;
      }) as unknown as typeof global.fetch;
      render(
        <MemoryRouter>
          <Premium />
        </MemoryRouter>,
      );

      expect(await screen.findByText(/Renews on/)).toBeInTheDocument();
    });
  });

  describe('the demo payment controls', () => {
    it('are absent on an instance connected to a real provider', async () => {
      renderPage(state({ available: true, sandbox: false, subscription: null }));

      await screen.findByRole('button', { name: /subscribe/i });
      expect(screen.queryByText(/demo payment controls/i)).not.toBeInTheDocument();
    });

    it('appear, and say plainly that nothing is charged, when the provider is fake', async () => {
      renderPage(state({ available: true, sandbox: true, subscription: null }));

      expect(await screen.findByText(/demo payment controls/i)).toBeInTheDocument();
      expect(screen.getByText(/nothing here charges anybody/i)).toBeInTheDocument();
    });

    it('stay reachable once subscribed, which is the only way back to a refund', async () => {
      // Subscribing replaces the Subscribe button with a status panel. Without this the demo has
      // no route to the outcomes that matter most — a failed renewal, a refund.
      renderPage(
        state({
          available: true,
          sandbox: true,
          subscription: {
            status: 'ACTIVE',
            currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            cancelAtPeriodEnd: false,
          },
        }),
      );

      expect(
        await screen.findByRole('button', { name: /open the demo checkout/i }),
      ).toBeInTheDocument();
    });
  });
});
