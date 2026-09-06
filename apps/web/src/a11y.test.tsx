import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RecommendationCard } from './components/RecommendationCard';
import { recommendation } from './test-support';

const noNotifications = {
  unreadCount: 0,
  items: [],
  loading: false,
  failed: false,
  open: vi.fn(),
};

describe('accessibility basics', () => {
  it('keeps the donation ask out of the page, and off a creator board entirely', async () => {
    // It used to be a footer under every page. Now it is behind the header's More menu, so it
    // is one press away rather than sitting underneath whatever the reader came to do.
    const { unmount } = render(
      <MemoryRouter initialEntries={['/']}>
        <Layout
          user={null}
          loadingSession={false}
          onSignOut={vi.fn()}
          notifications={noNotifications}
        >
          <p>content</p>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /support the developers/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: /support the developers/i })).toBeInTheDocument();
    unmount();

    // A donation ask on a creator's page competes with that creator's own Patreon ask, in front
    // of an audience that came for them.
    render(
      <MemoryRouter initialEntries={['/c/ada-writes']}>
        <Layout
          user={null}
          loadingSession={false}
          onSignOut={vi.fn()}
          notifications={noNotifications}
        >
          <p>content</p>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/support the developers/i)).not.toBeInTheDocument();
  });

  it('offers a sign-in link when signed out and a sign-out button when signed in', () => {
    const { rerender } = render(
      <MemoryRouter>
        <Layout
          user={null}
          loadingSession={false}
          onSignOut={vi.fn()}
          notifications={noNotifications}
        >
          <p>content</p>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /sign in with patreon/i })).toHaveAttribute(
      'href',
      '/auth/patreon/login',
    );

    rerender(
      <MemoryRouter>
        <Layout
          user={{
            id: 'u',
            patreonUserId: 'p',
            fullName: 'Ada',
            avatarUrl: null,
            isPremium: false,
          }}
          loadingSession={false}
          onSignOut={vi.fn()}
          notifications={noNotifications}
        >
          <p>content</p>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('keeps a live region mounted so its updates are announced', () => {
    const { container } = render(
      <MemoryRouter>
        <ul>
          <RecommendationCard
            slug="s"
            recommendation={recommendation()}
            canUpvote
            canModerate={false}
            onStatusChanged={vi.fn()}
            onCount={vi.fn()}
          />
        </ul>
      </MemoryRouter>,
    );
    // Screen readers announce mutations of an existing region; one that appears already
    // populated is unreliably announced.
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it('gives the upvote control an accessible name naming its suggestion', () => {
    render(
      <MemoryRouter>
        <ul>
          <RecommendationCard
            slug="s"
            recommendation={recommendation({ upvoteCount: 7 })}
            canUpvote
            canModerate={false}
            onStatusChanged={vi.fn()}
            onCount={vi.fn()}
          />
        </ul>
      </MemoryRouter>,
    );
    // Naming the entry matters: otherwise every button on the board reads "7 upvotes".
    expect(
      screen.getByRole('button', { name: /upvote Spirited Away — 7 upvotes/i }),
    ).toBeInTheDocument();
  });

  it('uses no positive tabIndex anywhere in a rendered card', () => {
    const { container } = render(
      <MemoryRouter>
        <ul>
          <RecommendationCard
            slug="s"
            recommendation={recommendation()}
            canUpvote
            canModerate={false}
            onStatusChanged={vi.fn()}
            onCount={vi.fn()}
          />
        </ul>
      </MemoryRouter>,
    );
    const positive = [...container.querySelectorAll('[tabindex]')].filter(
      (el) => Number(el.getAttribute('tabindex')) > 0,
    );
    // A positive tabIndex reorders the whole page's tab sequence, not just this component.
    expect(positive).toHaveLength(0);
  });

  it('exposes headings for the page structure', () => {
    render(
      <MemoryRouter>
        <ul>
          <RecommendationCard
            slug="s"
            recommendation={recommendation()}
            canUpvote
            canModerate={false}
            onStatusChanged={vi.fn()}
            onCount={vi.fn()}
          />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Spirited Away' })).toBeInTheDocument();
  });
});
