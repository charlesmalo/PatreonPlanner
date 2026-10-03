import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionPicker } from './RegionPicker';

const props = {
  region: null as string | null,
  regions: ['US', 'GB', 'FR'],
  fallback: 'US',
  onChange: vi.fn(),
};

describe('RegionPicker', () => {
  it('renders nothing where there is no choice to make', () => {
    // A deployment serving one region offers a control whose only option is already in effect.
    const { container } = render(<RegionPicker {...props} regions={['US']} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the region list has arrived', () => {
    const { container } = render(<RegionPicker {...props} regions={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names countries rather than showing codes', () => {
    // "DE" is not what a reader calls Germany.
    render(<RegionPicker {...props} regions={['US', 'DE']} />);

    expect(screen.getByRole('option', { name: 'Germany' })).toBeInTheDocument();
  });

  it('shows the server default until the reader chooses', () => {
    render(<RegionPicker {...props} region={null} fallback="GB" />);

    expect(screen.getByLabelText(/where to watch/i)).toHaveValue('GB');
  });

  it('shows the reader&apos;s own choice once made', () => {
    render(<RegionPicker {...props} region="FR" fallback="US" />);

    expect(screen.getByLabelText(/where to watch/i)).toHaveValue('FR');
  });

  it('reports a change', async () => {
    const onChange = vi.fn();
    render(<RegionPicker {...props} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText(/where to watch/i), 'FR');

    expect(onChange).toHaveBeenCalledWith('FR');
  });
});
