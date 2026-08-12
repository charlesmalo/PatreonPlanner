import { render, screen } from '@testing-library/react';
import { WatchOrderList } from './WatchOrderList';
import type { WatchOrderItem } from '../api/types';

const item = (overrides: Partial<WatchOrderItem> = {}): WatchOrderItem => ({
  position: 0,
  customTitle: 'The Phantom Menace',
  note: null,
  title: null,
  ...overrides,
});

describe('WatchOrderList', () => {
  it('renders nothing when there are no steps', () => {
    const { container } = render(<WatchOrderList items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders steps in the order given, numbered', () => {
    render(
      <WatchOrderList
        items={[item(), item({ position: 1, customTitle: 'Attack of the Clones' })]}
      />,
    );
    const entries = screen.getAllByRole('listitem').map((n) => n.textContent);
    expect(entries[0]).toContain('The Phantom Menace');
    expect(entries[1]).toContain('Attack of the Clones');
    expect(entries[0]).toContain('1');
  });

  it('shows a bound step by its canonical name', () => {
    render(
      <WatchOrderList
        items={[
          item({
            customTitle: null,
            title: {
              id: 't1',
              tmdbId: 129,
              mediaType: 'MOVIE',
              name: 'Spirited Away',
              year: 2001,
              posterPath: null,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Spirited Away/)).toBeInTheDocument();
  });

  it('renders a note as text', () => {
    render(<WatchOrderList items={[item({ note: 'start here' })]} />);
    expect(screen.getByText('start here')).toBeInTheDocument();
  });

  it('renders a step title containing markup as text', () => {
    const { container } = render(<WatchOrderList items={[item({ customTitle: '<img src=x>' })]} />);
    expect(screen.getByText('<img src=x>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
