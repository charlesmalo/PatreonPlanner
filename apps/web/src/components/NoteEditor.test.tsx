import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteEditor } from './NoteEditor';
import { fakeApi } from '../test-support';

const created = {
  id: 'n1',
  kind: 'NOTE',
  body: 'written',
  plannedFor: null,
  createdAt: '2026-01-01',
  author: { id: 'u1', fullName: 'Ada', avatarUrl: null },
};

function renderEditor(onWritten = vi.fn()) {
  render(<NoteEditor slug="ada-writes" recommendationId="rec-1" onWritten={onWritten} />);
  return onWritten;
}

describe('NoteEditor', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const routes = (overrides = {}) => ({
    'POST /api/v1/creators/ada-writes/recommendations/rec-1/notes': created,
    ...overrides,
  });

  it('posts commentary by default', async () => {
    const fetchMock = fakeApi(routes());
    global.fetch = fetchMock;
    const onWritten = renderEditor();
    await userEvent.type(screen.getByLabelText(/note/i), 'written');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));

    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ kind: 'NOTE', body: 'written' });
    expect(onWritten).toHaveBeenCalledWith(created);
  });

  it('offers a date only for a timeline note', async () => {
    // A date on commentary has no meaning and the API rejects it.
    global.fetch = fakeApi(routes());
    renderEditor();
    expect(screen.queryByLabelText(/when/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/kind/i), 'TIMELINE');
    expect(screen.getByLabelText(/when/i)).toBeInTheDocument();
  });

  it('sends the planned date with a timeline note', async () => {
    const fetchMock = fakeApi(routes());
    global.fetch = fetchMock;
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(/kind/i), 'TIMELINE');
    await userEvent.type(screen.getByLabelText(/note/i), 'March');
    await userEvent.type(screen.getByLabelText(/when/i), '2026-03-01');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));

    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(posted?.[1]?.body));
    expect(body.kind).toBe('TIMELINE');
    expect(body.plannedFor).toMatch(/^2026-03-01/);
  });

  it('warns that a timeline note is public before it is written', async () => {
    // There is no draft state; picking the wrong kind publishes it.
    global.fetch = fakeApi(routes());
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(/kind/i), 'TIMELINE');
    expect(screen.getByText(/patrons will see/i)).toBeInTheDocument();
  });

  it('blocks an empty note without a request', async () => {
    const fetchMock = fakeApi({});
    global.fetch = fetchMock;
    renderEditor();
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/write something/i);
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
  });

  it('shows a rejection from the moderation pipeline', async () => {
    global.fetch = fakeApi(
      routes({ 'POST /api/v1/creators/ada-writes/recommendations/rec-1/notes': new Error('400') }),
    );
    renderEditor();
    await userEvent.type(screen.getByLabelText(/note/i), 'nope');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/rejected/i);
  });
});
