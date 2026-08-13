import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StaffPage } from './StaffPage';
import { creator, fakeApi } from '../test-support';

const members = [
  { userId: 'u1', role: 'OWNER', fullName: 'Ada', avatarUrl: null, createdAt: '2026-01-01' },
  { userId: 'u2', role: 'MOD', fullName: 'Grace', avatarUrl: null, createdAt: '2026-01-02' },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/c/ada-writes/staff']}>
      <Routes>
        <Route path="/c/:slug/staff" element={<StaffPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StaffPage', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const routes = (overrides: Record<string, unknown> = {}) => ({
    'GET /api/v1/creators/ada-writes': creator,
    'GET /api/v1/creators/ada-writes/staff': { members, invites: [] },
    ...overrides,
  });

  it('lists members with their roles', async () => {
    global.fetch = fakeApi(routes());
    renderPage();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getByText(/owner/i)).toBeInTheDocument();
  });

  it('shows the invite link once, with a warning that it will not be shown again', async () => {
    global.fetch = fakeApi(
      routes({
        'POST /api/v1/creators/ada-writes/staff/invites': {
          token: 'tok_abc123',
          expiresAt: '2026-02-01T00:00:00.000Z',
        },
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /invite a moderator/i }));

    const link = await screen.findByDisplayValue(/\/invite#tok_abc123$/);
    expect(link).toBeInTheDocument();
    expect(screen.getByText(/not be shown again/i)).toBeInTheDocument();
  });

  it('lists pending invitations and revokes one', async () => {
    // The 409 message tells an owner to revoke one first; without this there was nothing to
    // revoke with, and invites live a week.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/staff': {
        members,
        invites: [{ id: 'i1', role: 'MOD', expiresAt: '2026-02-01', createdAt: '2026-01-01' }],
      },
      'DELETE /api/v1/creators/ada-writes/staff/invites/i1': null,
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /revoke the invitation/i }));
    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
  });

  it('offers no remove control for the owner', async () => {
    // The API refuses anyway; offering a button that cannot work is a lie.
    global.fetch = fakeApi(routes());
    renderPage();
    await screen.findByText('Ada');
    expect(screen.getByRole('button', { name: /remove Grace/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove Ada/i })).not.toBeInTheDocument();
  });

  it('removes a moderator and drops them from the list', async () => {
    global.fetch = fakeApi(routes({ 'DELETE /api/v1/creators/ada-writes/staff/u2': null }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /remove Grace/i }));
    expect(await screen.findByText(/no longer a moderator/i)).toBeInTheDocument();
    expect(screen.queryByText('Grace')).not.toBeInTheDocument();
  });

  it('explains a refusal rather than crashing', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/staff': new Error('403'),
    });
    renderPage();
    expect(await screen.findByText(/only the creator can manage moderators/i)).toBeInTheDocument();
  });

  it('renders a member name containing markup as text', async () => {
    global.fetch = fakeApi(
      routes({
        'GET /api/v1/creators/ada-writes/staff': {
          members: [{ ...members[1], fullName: '<img src=x>' }],
          invites: [],
        },
      }),
    );
    const { container } = renderPage();
    expect(await screen.findByText('<img src=x>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
