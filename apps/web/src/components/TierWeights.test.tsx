import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TierWeights } from './TierWeights';
import { fakeApi } from '../test-support';

/**
 * What a vote from each tier counts for.
 *
 * `PATCH /creators/:slug/tiers/:id` has existed since weighted voting shipped and nothing called
 * it, so every tier sat at the default of 1 — which makes `weightedScore` identical to the raw
 * count, and the board's "Top rated" sort a plain popularity sort.
 */
const tiers = [
  { id: 't-lo', title: 'Sidekick', amountCents: 500, order: 0, voteWeight: 1 },
  { id: 't-hi', title: 'Producer', amountCents: 1500, order: 1, voteWeight: 1 },
];

describe('TierWeights', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('lists each tier with what its vote is worth', () => {
    global.fetch = fakeApi({});
    render(<TierWeights slug="ada-writes" tiers={tiers} />);

    expect(screen.getByLabelText(/Sidekick/)).toHaveValue(1);
    expect(screen.getByLabelText(/Producer/)).toHaveValue(1);
  });

  it('saves a new weight', async () => {
    const fetchMock = fakeApi({
      'PATCH /api/v1/creators/ada-writes/tiers/t-hi': { id: 't-hi', voteWeight: 3 },
    });
    global.fetch = fetchMock;
    render(<TierWeights slug="ada-writes" tiers={tiers} />);

    const field = screen.getByLabelText(/Producer/);
    await userEvent.clear(field);
    await userEvent.type(field, '3');
    await userEvent.tab();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i));
    const sent = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ voteWeight: 3 });
  });

  it('says that zero means a tier votes for nothing, rather than hiding it', () => {
    // Zero is allowed by the API on purpose — a creator may decide a tier carries no voting
    // power — and it is the one value whose effect is not obvious from the number.
    global.fetch = fakeApi({});
    render(<TierWeights slug="ada-writes" tiers={tiers} />);

    expect(screen.getByText(/zero/i)).toBeInTheDocument();
  });

  it('does not send a weight the API would refuse', async () => {
    // 0 to 1000. Sending 5000 earns a 400 that reads like the page is broken.
    const fetchMock = fakeApi({});
    global.fetch = fetchMock;
    render(<TierWeights slug="ada-writes" tiers={tiers} />);

    const field = screen.getByLabelText(/Producer/);
    await userEvent.clear(field);
    await userEvent.type(field, '5000');
    await userEvent.tab();

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(await screen.findByRole('status')).toHaveTextContent(/between 0 and 1000/i);
  });

  it('puts the old weight back when a save fails', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/tiers/t-hi': new Error('500'),
    });
    render(<TierWeights slug="ada-writes" tiers={tiers} />);

    const field = screen.getByLabelText(/Producer/);
    await userEvent.clear(field);
    await userEvent.type(field, '7');
    await userEvent.tab();

    expect(await screen.findByRole('status')).toHaveTextContent(/did not save/i);
    expect(screen.getByLabelText(/Producer/)).toHaveValue(1);
  });
});
