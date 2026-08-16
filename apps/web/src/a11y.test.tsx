import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RecommendationCard } from './components/RecommendationCard';
import { recommendation } from './test-support';

const noNotifications = { unreadCount: 0, items: [], loading: false, open: vi.fn() };

describe('accessibility basics', () => {
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
          user={{ id: 'u', patreonUserId: 'p', fullName: 'Ada', avatarUrl: null }}
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
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={recommendation()}
          canUpvote
          canModerate={false}
          onStatusChanged={vi.fn()}
          onCount={vi.fn()}
        />
      </ul>,
    );
    // Screen readers announce mutations of an existing region; one that appears already
    // populated is unreliably announced.
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it('gives the upvote control an accessible name naming its suggestion', () => {
    render(
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={recommendation({ upvoteCount: 7 })}
          canUpvote
          canModerate={false}
          onStatusChanged={vi.fn()}
          onCount={vi.fn()}
        />
      </ul>,
    );
    // Naming the entry matters: otherwise every button on the board reads "7 upvotes".
    expect(
      screen.getByRole('button', { name: /upvote Spirited Away — 7 upvotes/i }),
    ).toBeInTheDocument();
  });

  it('uses no positive tabIndex anywhere in a rendered card', () => {
    const { container } = render(
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={recommendation()}
          canUpvote
          canModerate={false}
          onStatusChanged={vi.fn()}
          onCount={vi.fn()}
        />
      </ul>,
    );
    const positive = [...container.querySelectorAll('[tabindex]')].filter(
      (el) => Number(el.getAttribute('tabindex')) > 0,
    );
    // A positive tabIndex reorders the whole page's tab sequence, not just this component.
    expect(positive).toHaveLength(0);
  });

  it('exposes headings for the page structure', () => {
    render(
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={recommendation()}
          canUpvote
          canModerate={false}
          onStatusChanged={vi.fn()}
          onCount={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByRole('heading', { name: 'Spirited Away' })).toBeInTheDocument();
  });
});
