import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinkCandidates } from './LinkCandidates';
import type { RecommendationLink, StaffPermission } from '../api/types';

const candidate: RecommendationLink = {
  id: 'l1',
  url: 'https://example.test/a',
  label: null,
  isPreferred: false,
};

const editor = { canModerate: true, permissions: ['EDIT_ENTRIES'] as StaffPermission[] };

function renderCandidates(
  candidates: RecommendationLink[] = [candidate],
  viewer: { canModerate: boolean; permissions: StaffPermission[] } = editor,
) {
  return render(
    <LinkCandidates
      slug="ada-writes"
      candidates={candidates}
      canModerate={viewer.canModerate}
      permissions={viewer.permissions}
    />,
  );
}

describe('LinkCandidates', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ok = () =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);

  it('renders nothing when there are no candidates', () => {
    const { container } = renderCandidates([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers publish and discard to staff who may edit entries', () => {
    renderCandidates();
    expect(screen.getByRole('button', { name: /publish/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
  });

  it('offers no controls to a moderator without EDIT_ENTRIES', () => {
    // They are sent candidates — every staff member is — but the endpoint refuses them, and a
    // button that cannot work is a lie. StaffPage holds the same line for the owner row.
    renderCandidates([candidate], {
      canModerate: true,
      permissions: ['HANDLE_REPORTS'],
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells a submitter their own link is waiting, with no controls', () => {
    // A non-staff viewer is only ever sent their own candidate, so this heading is always true
    // for them. It exists to stop them submitting the same link again.
    renderCandidates([candidate], { canModerate: false, permissions: [] });
    expect(screen.getByText(/your link is waiting/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a candidate URL as text, never as a link', () => {
    // A published link carries the creator's endorsement; a candidate is an unreviewed
    // stranger's URL. Making it clickable hands out exactly the reach being withheld.
    renderCandidates();
    expect(screen.getByText('https://example.test/a')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a javascript: candidate as inert text', () => {
    renderCandidates([{ ...candidate, url: 'javascript:alert(1)' }]);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('never turns a javascript: candidate into an href, even once published', async () => {
    // The publish path is where an unreviewed URL becomes an attribute, so the scheme check has
    // to sit there and not only on the pending row. React warns on a javascript: href; it does
    // not block it.
    global.fetch = ok();
    renderCandidates([{ ...candidate, url: 'javascript:alert(1)' }]);

    await userEvent.click(screen.getByRole('button', { name: /publish/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /publish/i })).toBeNull());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('publishes a candidate and shows it as a real link', async () => {
    const fetchMock = ok();
    global.fetch = fetchMock;
    renderCandidates();

    await userEvent.click(screen.getByRole('button', { name: /publish/i }));

    await waitFor(() => expect(screen.getByRole('link')).toHaveAttribute('href', candidate.url));
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(path)).toContain('/creators/ada-writes/links/l1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'PUBLISHED' });
  });

  it('opens a published link without handing it a reference back', async () => {
    global.fetch = ok();
    renderCandidates();
    await userEvent.click(screen.getByRole('button', { name: /publish/i }));

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('discards a candidate and drops it from the list', async () => {
    const fetchMock = ok();
    global.fetch = fetchMock;
    renderCandidates();

    await userEvent.click(screen.getByRole('button', { name: /discard/i }));

    await waitFor(() =>
      expect(screen.queryByText('https://example.test/a')).not.toBeInTheDocument(),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });

  it('puts a candidate back when the server refuses to discard it', async () => {
    // Optimistic, then reconciled: a list that goes on claiming a row is gone when the server
    // still has it sends the creator back to a candidate they think they handled.
    global.fetch = vi.fn(
      async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response,
    );
    renderCandidates();

    await userEvent.click(screen.getByRole('button', { name: /discard/i }));

    expect(await screen.findByText('https://example.test/a')).toBeInTheDocument();
  });

  it('shows a label alongside the URL when one was submitted', () => {
    renderCandidates([{ ...candidate, label: 'Trailer' }]);
    expect(screen.getByText(/Trailer/)).toBeInTheDocument();
  });

  it('renders a label containing markup as text', () => {
    const { container } = renderCandidates([{ ...candidate, label: '<img src=x>' }]);
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
