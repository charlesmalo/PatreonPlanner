import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PickButton } from './PickButton';

describe('PickButton', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stub() {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${new URL(String(input), 'http://localhost').pathname}`);
      return { ok: true, status: 204 } as Response;
    });
    return calls;
  }

  it('names what it does, and what it would do to', () => {
    render(<PickButton slug="ada-writes" recommendationId="r1" title="Akira" isPick={false} />);

    expect(screen.getByRole('button', { name: /pick “Akira”/i })).toBeInTheDocument();
  });

  it('picks an entry', async () => {
    const calls = stub();
    render(<PickButton slug="ada-writes" recommendationId="r1" title="Akira" isPick={false} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(calls).toEqual(['POST /api/v1/creators/ada-writes/recommendations/r1/pick']),
    );
  });

  it('takes the pick back', async () => {
    const calls = stub();
    render(<PickButton slug="ada-writes" recommendationId="r1" title="Akira" isPick />);

    await userEvent.click(screen.getByRole('button', { name: /unpick/i }));

    await waitFor(() =>
      expect(calls).toEqual(['DELETE /api/v1/creators/ada-writes/recommendations/r1/pick']),
    );
  });

  it('puts the control back when the server refuses', async () => {
    // Optimistic, then reconciled: a control that keeps claiming a change the server rejected is
    // worse than one that flickers.
    global.fetch = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    render(<PickButton slug="ada-writes" recommendationId="r1" title="Akira" isPick={false} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^pick/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
  });
});
