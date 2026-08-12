import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeFilter } from './ThemeFilter';

const themes = [
  { id: 't1', name: 'Anime', titleCount: 3 },
  { id: 't2', name: 'Fantasy', titleCount: 1 },
];

describe('ThemeFilter', () => {
  it('renders nothing when the board has no themes', () => {
    // An empty control is worse than none: it suggests filtering exists and does nothing.
    const { container } = render(<ThemeFilter themes={[]} selected={null} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one control per theme with its count', () => {
    render(<ThemeFilter themes={themes} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Anime \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fantasy \(1\)/ })).toBeInTheDocument();
  });

  it('reports the chosen theme', async () => {
    const onSelect = vi.fn();
    render(<ThemeFilter themes={themes} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /Anime/ }));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('clears the filter when the selected theme is clicked again', async () => {
    const onSelect = vi.fn();
    render(<ThemeFilter themes={themes} selected="t1" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /Anime/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('marks the selected theme as pressed', () => {
    render(<ThemeFilter themes={themes} selected="t1" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Anime/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Fantasy/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('renders a theme name containing markup as text', () => {
    const { container } = render(
      <ThemeFilter
        themes={[{ id: 't1', name: '<img src=x>', titleCount: 1 }]}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/<img src=x>/)).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
