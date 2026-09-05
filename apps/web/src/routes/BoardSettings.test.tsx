import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BoardSettings } from './BoardSettings';
import { creator, fakeApi } from '../test-support';

const policy = {
  viewVisibility: 'SUBSCRIBERS_ONLY',
  submitMinTierId: null,
  upvoteMinTierId: null,
  hidePendingFromPublic: false,
  allowAnonymousTickets: false,
  allowReactions: true,
  acceptsCarryOver: true,
  allowVoteRatchet: true,
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/c/ada-writes/settings']}>
      <Routes>
        <Route path="/c/:slug/settings" element={<BoardSettings />} />
      </Routes>
    </MemoryRouter>,
  );

describe('BoardSettings', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const withPolicy = (overrides: object = {}, extra: object = {}) => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': { administer: true, permissions: [] },
      'GET /api/v1/creators/creator-1/policy': { ...policy, ...overrides },
      'PATCH /api/v1/creators/creator-1/policy': { ...policy, ...overrides },
      ...extra,
    });
  };

  it('shows which visibility the board currently has', async () => {
    withPolicy();
    renderPage();

    expect(await screen.findByRole('radio', { name: /only my supporters/i })).toBeChecked();
  });

  it('says what each choice exposes, not just what it is called', async () => {
    // "Public" sounds harmless. A creator choosing it should know they are publishing a list of
    // what they are watching, because that is the thing being scraped.
    withPolicy();
    renderPage();

    expect(await screen.findByText(/those lists get scraped/i)).toBeInTheDocument();
    expect(screen.getByText(/indexable by search engines/i)).toBeInTheDocument();
  });

  it('warns that a free Patreon account is not a barrier', async () => {
    // The setting most likely to be chosen by mistake: it sounds like a restriction and is not
    // one against anything automated.
    withPolicy();
    renderPage();

    expect(await screen.findByText(/free to create/i)).toBeInTheDocument();
  });

  it('saves a visibility change', async () => {
    withPolicy();
    renderPage();
    await screen.findByRole('radio', { name: /only my supporters/i });

    await userEvent.click(screen.getByRole('radio', { name: /anyone at all/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i));
  });

  it('offers every switch the board actually has', async () => {
    // Four of these were in the database and reachable by nobody until this page existed.
    withPolicy();
    renderPage();

    expect(await screen.findByRole('checkbox', { name: /hide suggestions/i })).toBeInTheDocument();
    for (const name of [
      /anyone message the moderators/i,
      /allow reactions/i,
      /carried from other boards/i,
      /lift old votes/i,
    ]) {
      expect(screen.getByRole('checkbox', { name })).toBeInTheDocument();
    }
  });

  it('puts a switch back when the server refuses it', async () => {
    // The change is applied immediately so the control does not feel dead on a slow connection.
    // The price is that a refusal has to undo it, or the page quietly lies about the setting.
    withPolicy(
      {},
      {
        'PATCH /api/v1/creators/creator-1/policy': () => {
          throw Object.assign(new Error('nope'), { status: 500 });
        },
      },
    );
    renderPage();
    const reactions = await screen.findByRole('checkbox', { name: /allow reactions/i });
    expect(reactions).toBeChecked();

    await userEvent.click(reactions);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/did not save/i));
    expect(screen.getByRole('checkbox', { name: /allow reactions/i })).toBeChecked();
  });

  it('tells a moderator without the permission that it is grantable, not broken', async () => {
    // 403 is the ordinary answer for somebody who simply does not hold this power. Calling it a
    // failure is how a person files a bug report about working software — and it is worth saying
    // the creator can grant it, because they can.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': { administer: false, permissions: [] },
      'GET /api/v1/creators/creator-1/policy': () => {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      },
    });
    renderPage();

    expect(
      await screen.findByText(/do not have permission to change this board/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/can grant this from the moderators page/i)).toBeInTheDocument();
  });
});
