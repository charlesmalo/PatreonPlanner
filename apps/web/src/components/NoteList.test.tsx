import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteList } from './NoteList';
import type { CreatorNote } from '../api/types';

const note = (overrides: Partial<CreatorNote> = {}): CreatorNote => ({
  id: 'n1',
  kind: 'TIMELINE',
  body: 'Covering this in March',
  plannedFor: '2026-03-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  author: { id: 'u1', fullName: 'Ada', avatarUrl: null },
  ...overrides,
});

describe('NoteList', () => {
  it('renders nothing when there are none', () => {
    const { container } = render(<NoteList notes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a timeline note with its planned date', () => {
    render(<NoteList notes={[note()]} />);
    expect(screen.getByText('Covering this in March')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it('renders commentary without a date', () => {
    render(<NoteList notes={[note({ kind: 'NOTE', body: 'internal', plannedFor: null })]} />);
    expect(screen.getByText('internal')).toBeInTheDocument();
    expect(screen.queryByText(/2026-03/)).not.toBeInTheDocument();
  });

  it('shows the author', () => {
    render(<NoteList notes={[note()]} />);
    expect(screen.getByText(/Ada/)).toBeInTheDocument();
  });

  it('marks which kind a note is, so a moderator sees at a glance what is public', () => {
    render(<NoteList notes={[note({ kind: 'NOTE', plannedFor: null }), note({ id: 'n2' })]} />);
    expect(screen.getByText(/private/i)).toBeInTheDocument();
    expect(screen.getByText(/public/i)).toBeInTheDocument();
  });

  it('offers no delete control unless a staff surface asks for one', () => {
    render(<NoteList notes={[note()]} />);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('reports a deletion to its caller', async () => {
    const onDelete = vi.fn();
    render(<NoteList notes={[note()]} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /delete this timeline note/i }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }));
  });

  it('renders the planned date as it was picked, not shifted by the reader timezone', () => {
    // Stored at UTC midnight from a plain date input; rendered locally, the author who chose
    // 1 March reads 28 February back on their own machine.
    render(<NoteList notes={[note({ plannedFor: '2026-03-01T00:00:00.000Z' })]} />);
    // Asserted as a property, not a format: the rendered date is the reader's locale, and
    // pinning "3/1/2026" tests the runtime's formatting rather than the timezone handling.
    const rendered = screen.getByText((text) => /2026/.test(text) && /\b0?1\b|03-01/.test(text));
    expect(rendered).toBeInTheDocument();
    expect(rendered.textContent).not.toMatch(/28|02-2/);
  });

  it('renders a body containing markup as text', () => {
    const { container } = render(<NoteList notes={[note({ body: '<img src=x>' })]} />);
    expect(screen.getByText('<img src=x>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
