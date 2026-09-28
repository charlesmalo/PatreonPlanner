import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrantTokens } from './GrantTokens';
import { fakeApi } from '../test-support';

const people = [
  { userId: 'u1', name: 'Mo Ferran' },
  { userId: 'u2', name: 'Bea Okonjo' },
];

describe('GrantTokens', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders nothing when there is nobody to grant to', () => {
    // A form whose only field is an empty list reads as broken rather than not-yet-applicable.
    const { container } = render(<GrantTokens slug="ada-writes" people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('grants tokens with a reason', async () => {
    const fetch = fakeApi({ 'POST /api/v1/creators/ada-writes/tokens/grants': { available: 3 } });
    global.fetch = fetch;
    render(<GrantTokens slug="ada-writes" people={people} />);

    await userEvent.selectOptions(screen.getByLabelText(/who/i), 'u1');
    await userEvent.clear(screen.getByLabelText(/how many/i));
    await userEvent.type(screen.getByLabelText(/how many/i), '2');
    await userEvent.type(screen.getByLabelText(/what for/i), 'for working the queue');
    await userEvent.click(screen.getByRole('button', { name: /give/i }));

    await waitFor(() => {
      const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        userId: 'u1',
        amount: 2,
        reason: 'for working the queue',
      });
    });
  });

  it('will not grant without a recipient', async () => {
    const fetch = fakeApi({});
    global.fetch = fetch;
    render(<GrantTokens slug="ada-writes" people={people} />);

    await userEvent.type(screen.getByLabelText(/what for/i), 'thanks');
    await userEvent.click(screen.getByRole('button', { name: /give/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/choose who/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('will not grant without a reason, because the ledger keeps it', async () => {
    const fetch = fakeApi({});
    global.fetch = fetch;
    render(<GrantTokens slug="ada-writes" people={people} />);

    await userEvent.selectOptions(screen.getByLabelText(/who/i), 'u1');
    await userEvent.click(screen.getByRole('button', { name: /give/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/say what they are for/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a failure rather than appearing to have worked', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/tokens/grants': new Error('403'),
    });
    render(<GrantTokens slug="ada-writes" people={people} />);

    await userEvent.selectOptions(screen.getByLabelText(/who/i), 'u1');
    await userEvent.type(screen.getByLabelText(/what for/i), 'thanks');
    await userEvent.click(screen.getByRole('button', { name: /give/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/did not send/i);
  });

  it('renders a name containing markup as text', () => {
    const { container } = render(
      <GrantTokens slug="ada-writes" people={[{ userId: 'u1', name: '<img src=x>' }]} />,
    );
    expect(screen.getByRole('option', { name: '<img src=x>' })).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
