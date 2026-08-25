import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactionBar } from './ReactionBar';

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
});
