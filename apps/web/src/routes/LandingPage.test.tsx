import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from './LandingPage';

/**
 * The front page. It was 37 statements at 0% coverage — no test file — and passed under the
 * global gate.
 *
 * Its children are tested on their own, so the only thing this page decides is the one rule
 * written into it: the creator's way in is offered to a signed-in reader and withheld from a
 * signed-out one, because `/claim` lists the campaigns this account owns and has nothing to say
 * without a session.
 */
const renderPage = (signedIn: boolean) =>
  render(
    <MemoryRouter>
      <LandingPage signedIn={signedIn} />
    </MemoryRouter>,
  );

describe('LandingPage', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('leads with the slogan', () => {
    renderPage(false);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pitch. Plan. Play.');
  });

  it('hides the mascot from a screen reader, which the heading already describes', () => {
    // alt="" and aria-hidden are the point: naming the artwork would announce the product twice
    // before the slogan. Asserted because it is invisible in every other kind of check.
    const { container } = renderPage(false);

    const logo = container.querySelector('img');
    expect(logo).toHaveAttribute('alt', '');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
  });

  it('offers a signed-in reader a way to create a board', () => {
    renderPage(true);

    expect(screen.getByRole('link', { name: /create a board for it/i })).toHaveAttribute(
      'href',
      '/claim',
    );
  });

  it('withholds it from a signed-out reader, who can only be told to sign in', () => {
    renderPage(false);

    expect(screen.queryByRole('link', { name: /create a board for it/i })).not.toBeInTheDocument();
  });

  it('offers the search for somebody else’s board either way', () => {
    renderPage(false);

    expect(screen.getByLabelText(/find a creator/i)).toBeInTheDocument();
  });
});
