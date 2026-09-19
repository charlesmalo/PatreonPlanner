import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeFilter } from './ThemeFilter';

const themes = [
  { id: 't1', name: 'Anime', entryCount: 3 },
  { id: 't2', name: 'Fantasy', entryCount: 1 },
  { id: 't3', name: 'Documentary', entryCount: 2 },
];

const setup = (selected: string[][] = [], onChange = vi.fn()) => {
  render(<ThemeFilter themes={themes} selected={selected} onChange={onChange} />);
  return onChange;
};

describe('ThemeFilter', () => {
  it('renders nothing when the board has no labels', () => {
    // An empty control is worse than none: it suggests filtering exists and does nothing.
    const { container } = render(<ThemeFilter themes={[]} selected={[]} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is called Filter labels', () => {
    setup();
    expect(screen.getByRole('group', { name: /filter labels/i })).toBeInTheDocument();
  });

  it('renders one toggle per label, without a count', () => {
    // The count was board-wide while the control now sits inside one column, so it would claim a
    // number the entries underneath it do not add up to.
    setup();
    expect(screen.getByRole('button', { name: 'Anime' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Anime \(/ })).not.toBeInTheDocument();
  });

  it('adds a label to the selection rather than replacing it', async () => {
    const onChange = setup([['t1']]);
    await userEvent.click(screen.getByRole('button', { name: 'Fantasy' }));
    expect(onChange).toHaveBeenCalledWith([['t1'], ['t2']]);
  });

  it('removes a label when its toggle is pressed again', async () => {
    const onChange = setup([['t1'], ['t2']]);
    await userEvent.click(screen.getByRole('button', { name: 'Anime' }));
    expect(onChange).toHaveBeenCalledWith([['t2']]);
  });

  it('offers a remove button only on the labels actually filtering', async () => {
    setup([['t1']]);
    expect(screen.getByRole('button', { name: /remove anime filter/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /remove fantasy filter/i }),
    ).not.toBeInTheDocument();
  });

  it('removes just that label when its ✕ is pressed', async () => {
    const onChange = setup([['t1'], ['t2']]);
    await userEvent.click(screen.getByRole('button', { name: /remove anime filter/i }));
    expect(onChange).toHaveBeenCalledWith([['t2']]);
  });

  it('keeps focus on the label after removing it, rather than losing it to the page', async () => {
    // The ✕ disappears with the selection, so focus would land on <body> and a keyboard reader
    // would be dropped back to the top of the document. The toggle stays put, so focus goes there.
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeFilter themes={themes} selected={[['t1']]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove anime filter/i }));
    rerender(<ThemeFilter themes={themes} selected={[]} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Anime' })).toHaveFocus();
  });

  it('offers Clear all only while something is filtering', async () => {
    const { rerender } = render(<ThemeFilter themes={themes} selected={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
    rerender(<ThemeFilter themes={themes} selected={[['t1']]} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /clear all/i })).toBeInTheDocument();
  });

  it('clears every label at once', async () => {
    const onChange = setup([['t1'], ['t2']]);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('marks the filtering labels as pressed', () => {
    setup([['t1']]);
    expect(screen.getByRole('button', { name: 'Anime' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Fantasy' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('announces the current filter politely', () => {
    // A filter that changes the list underneath it without saying so leaves a screen-reader user
    // with no idea the page moved.
    setup([['t1']]);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/anime/i);
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('joins a group with a magnet between each pair', () => {
    render(<ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /split between anime and fantasy/i }),
    ).toBeInTheDocument();
  });

  it('splits a group at the magnet that was clicked', async () => {
    const onChange = vi.fn();
    render(<ThemeFilter themes={themes} selected={[['t1', 't2', 't3']]} onChange={onChange} />);
    await userEvent.click(
      screen.getByRole('button', { name: /split between fantasy and documentary/i }),
    );
    expect(onChange).toHaveBeenCalledWith([['t1', 't2'], ['t3']]);
  });

  it('gives a group one remove for the whole group, not one per label', () => {
    render(<ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /remove anime and fantasy filter/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^remove anime filter$/i }),
    ).not.toBeInTheDocument();
  });

  it('removes the whole group with that remove button', async () => {
    const onChange = vi.fn();
    render(<ThemeFilter themes={themes} selected={[['t1', 't2'], ['t3']]} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /remove anime and fantasy filter/i }));
    expect(onChange).toHaveBeenCalledWith([['t3']]);
  });

  it('keeps a single remove on an ungrouped label', () => {
    render(<ThemeFilter themes={themes} selected={[['t1']]} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /remove anime filter/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /split between/i })).not.toBeInTheDocument();
  });

  it('reads the whole expression aloud in words, not symbols', () => {
    render(<ThemeFilter themes={themes} selected={[['t1'], ['t2', 't3']]} onChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      /filtering by anime, or fantasy and documentary/i,
    );
  });

  it('keeps focus in the filter after removing a group', async () => {
    // The remove button goes with the selection, so focus would land on <body> and a keyboard
    // reader would be dropped at the top of the document. The label's toggle always survives.
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove anime and fantasy filter/i }));
    rerender(<ThemeFilter themes={themes} selected={[]} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Anime' })).toHaveFocus();
  });

  it('renders a label name containing markup as text', () => {
    const { container } = render(
      <ThemeFilter
        themes={[{ id: 't1', name: '<img src=x>', entryCount: 1 }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/<img src=x>/)).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
