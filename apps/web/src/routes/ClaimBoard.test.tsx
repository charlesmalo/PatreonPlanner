import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ClaimBoard } from './ClaimBoard';
import { fakeApi } from '../test-support';

/**
 * Creating a board.
 *
 * `POST /creators/claim` has existed since the beginning and nothing in the app called it, so
 * every board in this project was made by SQL or by a test. In production the product had no
 * front door for creators at all.
 */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/claim']}>
      <Routes>
        <Route path="/claim" element={<ClaimBoard />} />
        <Route path="/c/:slug" element={<p>the board</p>} />
      </Routes>
    </MemoryRouter>,
  );

const campaign = (id: string, name: string, claimed = false, slug: string | null = null) => ({
  patreonCampaignId: id,
  displayName: name,
  claimed,
  slug,
});

describe('ClaimBoard', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const withCampaigns = (items: object[], extra: object = {}) => {
    global.fetch = fakeApi({ 'GET /api/v1/creators/claimable': { items }, ...extra });
  };

  it('lists the campaigns this account owns', async () => {
    withCampaigns([campaign('c1', 'Ada Writes')]);
    renderPage();

    expect(await screen.findByText('Ada Writes')).toBeInTheDocument();
  });

  it('creates the board and goes to it', async () => {
    withCampaigns([campaign('c1', 'Ada Writes')], {
      'POST /api/v1/creators/claim': { id: 'cr1', slug: 'ada-writes', displayName: 'Ada Writes' },
    });
    renderPage();
    await screen.findByText('Ada Writes');

    await userEvent.click(screen.getByRole('button', { name: /create the board for Ada Writes/i }));

    expect(await screen.findByText('the board')).toBeInTheDocument();
  });

  it('links to a campaign that is already a board instead of offering it again', async () => {
    // Pressing claim on it returns 409. Sending them to the board they already made is the
    // answer they actually wanted.
    withCampaigns([campaign('c1', 'Ada Writes', true, 'ada-writes')]);
    renderPage();

    expect(await screen.findByRole('link', { name: /Ada Writes/i })).toHaveAttribute(
      'href',
      '/c/ada-writes',
    );
    expect(
      screen.queryByRole('button', { name: /create the board for Ada Writes/i }),
    ).not.toBeInTheDocument();
  });

  it('explains an empty list rather than showing nothing', async () => {
    withCampaigns([]);
    renderPage();

    expect(await screen.findByText(/no campaigns/i)).toBeInTheDocument();
  });

  it('does not report an unreachable Patreon as owning no campaigns', async () => {
    // The two are different statements, and answering the first when the second is true sends a
    // creator away believing they have nothing to claim. The API is careful about this; so is
    // the page that renders it.
    withCampaigns([]);
    global.fetch = fakeApi({ 'GET /api/v1/creators/claimable': new Error('502') });
    renderPage();

    expect(await screen.findByText(/could not reach patreon/i)).toBeInTheDocument();
    expect(screen.queryByText(/no campaigns/i)).not.toBeInTheDocument();
  });

  it('says a board starts private, before one is made', async () => {
    // The default exists because a readable board is a list of what a creator is watching. A
    // creator should learn that when the board is created, not discover it later.
    withCampaigns([campaign('c1', 'Ada Writes')]);
    renderPage();

    expect(await screen.findByText(/only your supporters/i)).toBeInTheDocument();
  });

  it('does not leave the button pressable while the board is being made', async () => {
    // Two presses are two claims; the second answers 409 and reads like a failure on a board
    // that was in fact created.
    let resolve: (value: Response) => void = () => {};
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'GET')
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [campaign('c1', 'Ada Writes')] }),
        } as Response;
      return new Promise((r) => {
        resolve = r;
      }) as Promise<Response>;
    });
    renderPage();
    await screen.findByText('Ada Writes');

    const button = screen.getByRole('button', { name: /create the board for Ada Writes/i });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    resolve({ ok: true, status: 201, json: async () => ({ slug: 'ada-writes' }) } as Response);
  });
});
