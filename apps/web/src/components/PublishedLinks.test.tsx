import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublishedLinks } from './PublishedLinks';
import type { RecommendationLink } from '../api/types';

const link = (id: string, url: string, isPreferred = false): RecommendationLink => ({
  id,
  url,
  label: null,
  isPreferred,
});

describe('PublishedLinks', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stub(ok = true) {
    const sent: Array<{ url: string; body: unknown }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return { ok, status: ok ? 200 : 403, json: async () => ({}) } as Response;
    });
    return sent;
  }

  const setup = (props: Partial<Parameters<typeof PublishedLinks>[0]> = {}) =>
    render(
      <PublishedLinks
        slug="ada-writes"
        links={[link('l1', 'https://one.example'), link('l2', 'https://two.example')]}
        canModerate
        permissions={['EDIT_ENTRIES']}
        {...props}
      />,
    );

  it('renders each published link as a link', () => {
    setup({ canModerate: false, permissions: [] });

    expect(screen.getByRole('link', { name: 'https://one.example' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://two.example' })).toBeInTheDocument();
  });

  it('refuses to render a url that is not http', () => {
    // Submitter-chosen, so the same rule the card already applied has to survive the move.
    setup({ links: [link('l1', 'javascript:alert(1)')], canModerate: false, permissions: [] });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a link the board gained while the card stayed mounted', async () => {
    // A card is keyed by its entry id, so it survives a board refetch. Holding the list in state
    // would freeze it at mount: publishing a link elsewhere and refreshing the board would leave
    // it missing here until a full reload. Only the optimistic override is held locally.
    const { rerender } = render(
      <PublishedLinks
        slug="ada-writes"
        links={[link('l1', 'https://one.example')]}
        canModerate={false}
        permissions={[]}
      />,
    );
    expect(screen.queryByRole('link', { name: 'https://two.example' })).not.toBeInTheDocument();

    rerender(
      <PublishedLinks
        slug="ada-writes"
        links={[link('l1', 'https://one.example'), link('l2', 'https://two.example')]}
        canModerate={false}
        permissions={[]}
      />,
    );

    expect(screen.getByRole('link', { name: 'https://two.example' })).toBeInTheDocument();
  });

  it('lets a moderator choose which link readers see first', async () => {
    // The whole feature: `isPreferred` had a DTO, a single-preferred invariant kept in a
    // transaction, and a read path that orders by it — and no client ever sent it, so it was
    // false everywhere in every running system.
    const sent = stub();
    setup();

    await userEvent.click(screen.getByRole('button', { name: /prefer https:\/\/two\.example/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toContain('/creators/ada-writes/links/l2');
    expect(sent[0].body).toEqual({ isPreferred: true });
  });

  it('marks the preferred link and offers no control on it', async () => {
    setup({ links: [link('l1', 'https://one.example', true), link('l2', 'https://two.example')] });

    expect(await screen.findByText(/shown first/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /prefer https:\/\/one\.example/i }),
    ).not.toBeInTheDocument();
  });

  it('moves the marker as soon as it is pressed', async () => {
    stub();
    setup({ links: [link('l1', 'https://one.example', true), link('l2', 'https://two.example')] });

    await userEvent.click(screen.getByRole('button', { name: /prefer https:\/\/two\.example/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /prefer https:\/\/two\.example/i }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /prefer https:\/\/one\.example/i }),
    ).toBeInTheDocument();
  });

  it('puts the marker back when the server refuses', async () => {
    // The API checks EDIT_ENTRIES again regardless of what this component drew.
    stub(false);
    setup({ links: [link('l1', 'https://one.example', true), link('l2', 'https://two.example')] });

    await userEvent.click(screen.getByRole('button', { name: /prefer https:\/\/two\.example/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /prefer https:\/\/two\.example/i }),
      ).toBeInTheDocument(),
    );
  });

  it('offers nothing to a moderator without EDIT_ENTRIES', async () => {
    // Same gate the endpoint demands: MODERATE plus EDIT_ENTRIES. A control the API answers 403
    // to is worse than no control.
    setup({ permissions: [] });

    expect(screen.queryByRole('button', { name: /prefer/i })).not.toBeInTheDocument();
  });

  it('offers nothing to a reader', async () => {
    setup({ canModerate: false, permissions: ['EDIT_ENTRIES'] });

    expect(screen.queryByRole('button', { name: /prefer/i })).not.toBeInTheDocument();
  });
});
