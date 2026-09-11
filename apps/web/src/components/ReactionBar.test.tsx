import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FREE_REACTIONS, PREMIUM_REACTIONS, ReactionBar } from './ReactionBar';

describe('ReactionBar', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stub(reply: object) {
    const sent: unknown[] = [];
    global.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 201, json: async () => reply } as Response;
    });
    return sent;
  }

  const setup = (props: Partial<Parameters<typeof ReactionBar>[0]> = {}) =>
    render(
      <ReactionBar
        slug="ada-writes"
        recommendationId="rec-1"
        title="Akira"
        reactions={[]}
        canReact
        {...props}
      />,
    );

  it('shows a count beside an emote someone has used', () => {
    setup({ reactions: [{ emote: '🔥', count: 3, reacted: false }] });

    expect(screen.getByRole('button', { name: /🔥 3 on Akira/ })).toBeInTheDocument();
  });

  it('marks the reader own as pressed', () => {
    setup({ reactions: [{ emote: '🔥', count: 1, reacted: true }] });

    expect(screen.getByRole('button', { name: /🔥/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends the emote and takes the count from the server', async () => {
    const sent = stub({ emote: '🔥', count: 4, reacted: true });
    setup({ reactions: [{ emote: '🔥', count: 3, reacted: false }] });

    await userEvent.click(screen.getByRole('button', { name: /🔥/ }));

    await waitFor(() => expect(sent).toEqual([{ recommendationId: 'rec-1', emote: '🔥' }]));
    // Reconciled rather than guessed: two tabs would otherwise drift.
    expect(await screen.findByRole('button', { name: /🔥 4 on Akira/ })).toBeInTheDocument();
  });

  it('says so when the server refuses, rather than doing nothing visible', async () => {
    // The count is taken from the server rather than guessed, so a refusal leaves the row exactly
    // as it was — which from the reader's side is indistinguishable from a dead button. Upvoting
    // already answers this: "the server is what actually decides, so its refusal has to be shown
    // rather than assumed impossible."
    //
    // 429 stands in for the whole family here. The realistic members are an expired session, a
    // dropped connection and an entry removed while the page was open; the rate limiter is the
    // least likely of them, whatever an earlier version of this comment claimed.
    global.fetch = vi.fn(
      async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response,
    );
    setup({ reactions: [] });

    await userEvent.click(screen.getByRole('button', { name: /👍 0 on Akira/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/did not count/i));
  });

  it('drops an emote nobody is left using', async () => {
    stub({ emote: '🔥', count: 0, reacted: false });
    setup({ reactions: [{ emote: '🔥', count: 1, reacted: true }], canReact: false });

    // Nothing to click for a reader who cannot react, and the last one going leaves no trace.
    expect(screen.getByRole('button', { name: /🔥 1/ })).toBeDisabled();
  });

  it('offers the whole palette to someone who may react', () => {
    setup();

    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('shows a reader who may not react only what others used, and disabled', () => {
    // A row of six grey emotes on every card would be noise on a board nobody has reacted to.
    setup({ reactions: [{ emote: '👀', count: 2, reacted: false }], canReact: false });

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toBeDisabled();
  });

  it('renders nothing at all when nobody has reacted and the reader may not', () => {
    const { container } = render(
      <ReactionBar
        slug="ada-writes"
        recommendationId="rec-1"
        title="Akira"
        reactions={[]}
        canReact={false}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('offers a free reader only the half they can cast', () => {
    setup({ canReact: true, isPremium: false });

    expect(screen.getAllByRole('button')).toHaveLength(FREE_REACTIONS.length);
  });

  it('offers a premium reader the whole palette', () => {
    setup({ canReact: true, isPremium: true });

    expect(screen.getAllByRole('button')).toHaveLength(
      FREE_REACTIONS.length + PREMIUM_REACTIONS.length,
    );
  });

  it('still shows a premium reaction somebody else cast, with its count', () => {
    // Reading is never gated. Hiding it would make the count vanish for everyone who does not
    // pay, which is a lie about the data rather than a locked feature.
    setup({
      canReact: true,
      isPremium: false,
      reactions: [{ emote: PREMIUM_REACTIONS[0], count: 3, reacted: false }],
    });

    const locked = screen.getByRole('button', { name: new RegExp(`${PREMIUM_REACTIONS[0]} 3`) });
    expect(locked).toBeInTheDocument();
    // Visible and counted, but not castable by them.
    expect(locked).toBeDisabled();
  });

  it('names a locked emote as locked, so it is not read as broken', () => {
    setup({
      canReact: true,
      isPremium: false,
      reactions: [{ emote: PREMIUM_REACTIONS[1], count: 1, reacted: false }],
    });

    expect(
      screen.getByRole('button', { name: new RegExp('premium palette', 'i') }),
    ).toBeInTheDocument();
  });
});
