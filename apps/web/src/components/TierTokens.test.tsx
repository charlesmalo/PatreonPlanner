import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TierTokens } from './TierTokens';
import { fakeApi } from '../test-support';

const tiers = [
  { id: 't1', title: 'Sidekick', amountCents: 500, order: 0, voteWeight: 1, tokensPerPeriod: 0 },
  { id: 't2', title: 'Producer', amountCents: 1500, order: 1, voteWeight: 3, tokensPerPeriod: 2 },
];

describe('TierTokens', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows what each tier is granted now', () => {
    render(<TierTokens slug="ada-writes" tiers={tiers} />);
    expect(screen.getByLabelText(/sidekick/i)).toHaveValue(0);
    expect(screen.getByLabelText(/producer/i)).toHaveValue(2);
  });

  it('saves a changed grant on blur', async () => {
    const fetch = fakeApi({ 'PATCH /api/v1/creators/ada-writes/tiers/t1': {} });
    global.fetch = fetch;
    render(<TierTokens slug="ada-writes" tiers={tiers} />);

    const field = screen.getByLabelText(/sidekick/i);
    await userEvent.clear(field);
    await userEvent.type(field, '3');
    await userEvent.tab();

    await waitFor(() => {
      const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ tokensPerPeriod: 3 });
    });
  });

  it('sends nothing when the number has not changed', async () => {
    const fetch = fakeApi({ 'PATCH /api/v1/creators/ada-writes/tiers/t2': {} });
    global.fetch = fetch;
    render(<TierTokens slug="ada-writes" tiers={tiers} />);

    await userEvent.click(screen.getByLabelText(/producer/i));
    await userEvent.tab();

    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it('refuses a number outside the range without asking the server', async () => {
    // The API's 400 reads like the page is broken, because nothing on screen said the range.
    const fetch = fakeApi({});
    global.fetch = fetch;
    render(<TierTokens slug="ada-writes" tiers={tiers} />);

    const field = screen.getByLabelText(/sidekick/i);
    await userEvent.clear(field);
    await userEvent.type(field, '99');
    await userEvent.tab();

    expect(await screen.findByRole('status')).toHaveTextContent(/0 to 50/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('puts the old number back when a save fails', async () => {
    global.fetch = fakeApi({ 'PATCH /api/v1/creators/ada-writes/tiers/t2': new Error('500') });
    render(<TierTokens slug="ada-writes" tiers={tiers} />);

    const field = screen.getByLabelText(/producer/i);
    await userEvent.clear(field);
    await userEvent.type(field, '5');
    await userEvent.tab();

    expect(await screen.findByRole('status')).toHaveTextContent(/did not save/i);
    await waitFor(() => expect(screen.getByLabelText(/producer/i)).toHaveValue(2));
  });

  it('renders a tier name containing markup as text', () => {
    const { container } = render(
      <TierTokens
        slug="ada-writes"
        tiers={[
          {
            id: 't1',
            title: '<img src=x>',
            amountCents: 100,
            order: 0,
            voteWeight: 1,
            tokensPerPeriod: 0,
          },
        ]}
      />,
    );
    expect(screen.getByText(/<img src=x>/)).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
