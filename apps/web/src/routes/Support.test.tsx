import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

async function renderSupport(url?: string) {
  vi.resetModules();
  vi.stubEnv('VITE_DONATION_URL', url ?? '');
  const { Support } = await import('./Support');
  render(
    <MemoryRouter>
      <Support />
    </MemoryRouter>,
  );
}

describe('Support', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('says so when no donation link is configured, rather than showing a dead button', async () => {
    await renderSupport();

    expect(screen.getByText(/not set up on this deployment/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /coffee/i })).not.toBeInTheDocument();
  });

  it('preselects the median amount', async () => {
    await renderSupport('https://example.test/pay');

    expect(screen.getByRole('link', { name: /coffee — \$5/i })).toBeInTheDocument();
  });

  it('carries the chosen amount to the payment host', async () => {
    await renderSupport('https://example.test/pay');

    await userEvent.click(screen.getByRole('radio', { name: '$10' }));

    expect(screen.getByRole('link', { name: /coffee — \$10/i })).toHaveAttribute(
      'href',
      'https://example.test/pay/10',
    );
  });

  it('takes a custom amount', async () => {
    await renderSupport('https://example.test/pay');

    await userEvent.click(screen.getByRole('radio', { name: /another amount/i }));
    await userEvent.type(screen.getByLabelText(/amount in dollars/i), '25');

    expect(screen.getByRole('link', { name: /coffee — \$25/i })).toHaveAttribute(
      'href',
      'https://example.test/pay/25',
    );
  });

  it('refuses a custom amount that is not a positive number', async () => {
    // Typesafe > 0, as specified — a donation of zero or minus five is not a thing.
    await renderSupport('https://example.test/pay');

    await userEvent.click(screen.getByRole('radio', { name: /another amount/i }));
    await userEvent.type(screen.getByLabelText(/amount in dollars/i), '0');

    expect(await screen.findByRole('alert')).toHaveTextContent(/between \$1/i);
    expect(screen.getByRole('link', { name: /choose an amount/i })).toBeInTheDocument();
  });

  it('opens the payment host without handing it a reference back', async () => {
    await renderSupport('https://example.test/pay');

    const link = screen.getByRole('link', { name: /coffee/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('carries the disclaimer', async () => {
    await renderSupport('https://example.test/pay');

    expect(screen.getByText(/voluntary gift/i)).toBeInTheDocument();
    expect(screen.getByText(/not tax-deductible/i)).toBeInTheDocument();
  });
});
