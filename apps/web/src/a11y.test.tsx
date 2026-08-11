import { render, screen } from '@testing-library/react';
import { Layout } from './components/Layout';
import { RecommendationCard } from './components/RecommendationCard';
import { recommendation } from './test-support';

describe('accessibility basics', () => {
  it('offers a sign-in link when signed out and a sign-out button when signed in', () => {
    const { rerender } = render(
      <Layout user={null} loadingSession={false} onSignOut={vi.fn()}>
        <p>content</p>
      </Layout>,
    );
    expect(screen.getByRole('link', { name: /sign in with patreon/i })).toHaveAttribute(
      'href',
      '/auth/patreon/login',
    );

    rerender(
      <Layout
        user={{ id: 'u', patreonUserId: 'p', fullName: 'Ada', avatarUrl: null }}
        loadingSession={false}
        onSignOut={vi.fn()}
      >
        <p>content</p>
      </Layout>,
    );
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('gives the upvote control an accessible name including the count', () => {
    render(
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={recommendation({ upvoteCount: 7 })}
          canUpvote
          onCount={vi.fn()}
        />
      </ul>,
    );
    // "▲ 7 upvotes" — the arrow is aria-hidden, so the name is meaningful without it.
    expect(screen.getByRole('button', { name: /7 upvotes/i })).toBeInTheDocument();
  });

  it('uses no positive tabIndex anywhere in a rendered card', () => {
    const { container } = render(
      <ul>
        <RecommendationCard
          slug="s"
          recommendation={recommendation()}
          canUpvote
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
          onCount={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByRole('heading', { name: 'Spirited Away' })).toBeInTheDocument();
  });
});
