import { render, screen } from '@testing-library/react';
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

  it('renders a body containing markup as text', () => {
    const { container } = render(<NoteList notes={[note({ body: '<img src=x>' })]} />);
    expect(screen.getByText('<img src=x>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
