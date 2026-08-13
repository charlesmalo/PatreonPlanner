import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AcceptInvite } from './AcceptInvite';
import { fakeApi } from '../test-support';

function renderPage(user: { id: string } | null = { id: 'u9' }) {
  return render(
    <MemoryRouter initialEntries={['/invite#tok_abc']}>
      <Routes>
        <Route path="/invite" element={<AcceptInvite user={user as never} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AcceptInvite', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('asks a signed-out visitor to sign in', () => {
    // Consent means an authenticated action; there is nobody to appoint otherwise.
    renderPage(null);
    expect(screen.getByRole('link', { name: /sign in with patreon/i })).toBeInTheDocument();
  });

  it('accepts and names the board', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/staff/invites/accept': {
        role: 'MOD',
        creator: { slug: 'ada-writes', displayName: 'Ada Writes' },
      },
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(await screen.findByText(/Ada Writes/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to the board/i })).toHaveAttribute(
      'href',
      '/c/ada-writes',
    );
  });

  it('sends the token from the fragment, which never reaches a server log', async () => {
    const fetchMock = fakeApi({
      'POST /api/v1/staff/invites/accept': {
        role: 'MOD',
        creator: { slug: 's', displayName: 'S' },
      },
    });
    global.fetch = fetchMock;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /accept/i }));
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ token: 'tok_abc' });
  });

  it('shows one generic message for a spent or unknown invite', async () => {
    global.fetch = fakeApi({ 'POST /api/v1/staff/invites/accept': new Error('404') });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/no longer valid/i);
  });
});
