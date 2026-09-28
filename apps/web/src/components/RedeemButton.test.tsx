import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RedeemButton } from './RedeemButton';
import { fakeApi } from '../test-support';

const setup = (props: Partial<Parameters<typeof RedeemButton>[0]> = {}) => {
  const onRedeemed = vi.fn();
  render(
    <RedeemButton
      slug="ada-writes"
      recommendationId="rec-1"
      title="Cowboy Bebop"
      available={2}
      onRedeemed={onRedeemed}
      {...props}
    />,
  );
  return onRedeemed;
};

describe('RedeemButton', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders nothing at a balance of zero', () => {
    // Absent rather than present and failing: a control that always refuses is worse than none.
    const { container } = render(
      <RedeemButton
        slug="ada-writes"
        recommendationId="rec-1"
        title="Cowboy Bebop"
        available={0}
        onRedeemed={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('spends a token with the note', async () => {
    const fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/redeem': { id: 'r1' },
    });
    global.fetch = fetch;
    const onRedeemed = setup();

    await userEvent.click(screen.getByRole('button', { name: /redeem a token on/i }));
    await userEvent.type(screen.getByLabelText(/what should be played/i), 'S2E04');
    await userEvent.click(screen.getByRole('button', { name: /^spend$/i }));

    await waitFor(() => expect(onRedeemed).toHaveBeenCalled());
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ note: 'S2E04' });
  });

  it('will not spend without a note, because the note is the instruction', async () => {
    const fetch = fakeApi({});
    global.fetch = fetch;
    setup();

    await userEvent.click(screen.getByRole('button', { name: /redeem a token on/i }));
    await userEvent.click(screen.getByRole('button', { name: /^spend$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/say what/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says how many tokens are left', () => {
    setup({ available: 3 });
    expect(screen.getByRole('button', { name: /redeem a token on/i })).toHaveTextContent('3');
  });

  it('reports a refusal rather than appearing to have worked', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/redeem': new Error('409'),
    });
    const onRedeemed = setup();

    await userEvent.click(screen.getByRole('button', { name: /redeem a token on/i }));
    await userEvent.type(screen.getByLabelText(/what should be played/i), 'S2E04');
    await userEvent.click(screen.getByRole('button', { name: /^spend$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/could not/i);
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it('names the entry, so a screen reader knows which card this belongs to', () => {
    setup();
    expect(
      screen.getByRole('button', { name: /redeem a token on “Cowboy Bebop”/i }),
    ).toBeInTheDocument();
  });
});
