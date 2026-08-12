import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WatchOrderEditor, type DraftItem } from './WatchOrderEditor';
import { fakeApi } from '../test-support';

function Harness({ initial = [] as DraftItem[] }) {
  const [items, setItems] = useState<DraftItem[]>(initial);
  return (
    <>
      <WatchOrderEditor slug="ada-writes" items={items} onChange={setItems} />
      <output data-testid="order">{items.map((i) => i.customTitle).join('|')}</output>
    </>
  );
}

const order = () => screen.getByTestId('order').textContent;

describe('WatchOrderEditor', () => {
  it('renders no steps until one is added', () => {
    render(<Harness />);
    expect(screen.queryByLabelText('Step 1 title')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a step/i })).toBeInTheDocument();
  });

  it('adds a step', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /add a step/i }));
    await userEvent.type(screen.getByLabelText('Step 1 title'), 'One');
    expect(order()).toBe('One');
  });

  it('names every control by the step it acts on', async () => {
    // A long list of identical "Remove" buttons is unusable with a screen reader.
    render(<Harness initial={[{ customTitle: 'One' }, { customTitle: 'Two' }]} />);
    expect(screen.getByRole('button', { name: 'Remove step 2' })).toBeInTheDocument();
    expect(screen.getByLabelText('Step 2 title')).toBeInTheDocument();
  });

  it('removes the right step', async () => {
    render(<Harness initial={[{ customTitle: 'One' }, { customTitle: 'Two' }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 1' }));
    expect(order()).toBe('Two');
  });

  it('moves a step up', async () => {
    render(<Harness initial={[{ customTitle: 'One' }, { customTitle: 'Two' }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    expect(order()).toBe('Two|One');
  });

  it('moves a step down', async () => {
    render(<Harness initial={[{ customTitle: 'One' }, { customTitle: 'Two' }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(order()).toBe('Two|One');
  });

  it('offers no move-up on the first step or move-down on the last', () => {
    // The server numbers steps from array order, so a no-op control would be a lie.
    render(<Harness initial={[{ customTitle: 'One' }, { customTitle: 'Two' }]} />);
    expect(screen.queryByRole('button', { name: 'Move step 1 up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move step 2 down' })).not.toBeInTheDocument();
  });

  it('accepts a note per step', async () => {
    render(<Harness initial={[{ customTitle: 'One' }]} />);
    await userEvent.type(screen.getByLabelText('Step 1 note'), 'watch this first');
    expect(screen.getByLabelText('Step 1 note')).toHaveValue('watch this first');
  });

  it('shows a catalogue-bound step by its canonical name and offers no title field', () => {
    // Exactly one identity per step: the API rejects both, so the UI must not offer both.
    render(<Harness initial={[{ tmdbId: 129, mediaType: 'MOVIE', boundName: 'Spirited Away' }]} />);
    expect(screen.getByText('Spirited Away')).toBeInTheDocument();
    expect(screen.queryByLabelText('Step 1 title')).not.toBeInTheDocument();
  });
});

describe('WatchOrderEditor catalogue binding', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('binds a step to a catalogue result and stops offering a title field', async () => {
    // Without this the bound branch was unreachable in production: nothing anywhere set tmdbId,
    // so half of "steps may be catalogue-bound" was API-only.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/catalog/search': {
        results: [
          {
            tmdbId: 129,
            mediaType: 'MOVIE',
            name: 'Spirited Away',
            year: 2001,
            posterPath: null,
            overview: null,
          },
        ],
      },
    });
    render(<Harness initial={[{ customTitle: '' }]} />);
    await userEvent.type(screen.getByLabelText('Step 1 title'), 'spirited');
    await userEvent.click(await screen.findByRole('button', { name: /use spirited away/i }));

    expect(screen.getByText('Spirited Away')).toBeInTheDocument();
    expect(screen.queryByLabelText('Step 1 title')).not.toBeInTheDocument();
  });

  it('lets a bound step go back to free text', async () => {
    render(<Harness initial={[{ tmdbId: 129, mediaType: 'MOVIE', boundName: 'Spirited Away' }]} />);
    await userEvent.click(screen.getByRole('button', { name: /unlink step 1/i }));
    expect(screen.getByLabelText('Step 1 title')).toBeInTheDocument();
  });
});
