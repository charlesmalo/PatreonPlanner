import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookSecret } from './WebhookSecret';
import { fakeApi } from '../test-support';

/**
 * Registering the webhook secret.
 *
 * `PUT webhook-secret` has existed since Phase 1 and nothing called it, so per-creator Patreon
 * webhooks were dead in production — without a secret the signature guard rejects every delivery,
 * and membership changes arrived only from the periodic sync job.
 */
describe('WebhookSecret', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const withState = (configured: boolean, extra: object = {}) => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/creator-1/webhook-secret': { configured },
      ...extra,
    });
  };

  it('says when no secret is set, and what that costs', async () => {
    // Silence would be the worst answer: nothing visibly fails without one. The deliveries are
    // rejected and the board just updates more slowly.
    withState(false);
    render(<WebhookSecret creatorId="creator-1" />);

    expect(await screen.findByText(/no secret is set/i)).toBeInTheDocument();
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it('says when one is set without showing any part of it', async () => {
    // Any prefix of a secret is a head start, so there is nothing safe to show.
    withState(true);
    render(<WebhookSecret creatorId="creator-1" />);

    expect(await screen.findByText(/a secret is set/i)).toBeInTheDocument();
  });

  it('shows the URL to give Patreon, which is not guessable otherwise', async () => {
    // A creator with the secret field alone still cannot finish: the webhook has to point
    // somewhere, and the board id is not something they know.
    withState(false);
    render(<WebhookSecret creatorId="creator-1" />);

    // The whole path, anchored. A substring match passes on `/api/v1/webhooks/patreon/creator-1`
    // too, which is wrong — webhook routes are excluded from the global prefix — and a creator
    // registering that URL would have every delivery fail with nothing looking broken.
    expect(
      await screen.findByText(`${window.location.origin}/webhooks/patreon/creator-1`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/api\/v1\/webhooks/)).not.toBeInTheDocument();
  });

  it('does not put the secret in the field after saving it', async () => {
    withState(false, { 'PUT /api/v1/creators/creator-1/webhook-secret': { configured: true } });
    render(<WebhookSecret creatorId="creator-1" />);
    await screen.findByText(/no secret is set/i);

    const field = screen.getByLabelText(/signing secret/i);
    await userEvent.type(field, 'from-the-portal');
    await userEvent.click(screen.getByRole('button', { name: /save the secret/i }));

    expect(await screen.findByText(/a secret is set/i)).toBeInTheDocument();
    expect(field).toHaveValue('');
  });

  it('keeps the secret off the screen while it is typed', async () => {
    // A creator pasting this is often sharing their screen with whoever asked them to set it up.
    withState(false);
    render(<WebhookSecret creatorId="creator-1" />);
    await screen.findByText(/no secret is set/i);

    expect(screen.getByLabelText(/signing secret/i)).toHaveAttribute('type', 'password');
  });

  it('does not send an empty secret', async () => {
    const fetchMock = fakeApi({
      'GET /api/v1/creators/creator-1/webhook-secret': { configured: false },
    });
    global.fetch = fetchMock;
    render(<WebhookSecret creatorId="creator-1" />);
    await screen.findByText(/no secret is set/i);

    await userEvent.click(screen.getByRole('button', { name: /save the secret/i }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('says a save failed rather than claiming it worked', async () => {
    withState(false, {
      'PUT /api/v1/creators/creator-1/webhook-secret': new Error('500'),
    });
    render(<WebhookSecret creatorId="creator-1" />);
    await screen.findByText(/no secret is set/i);

    await userEvent.type(screen.getByLabelText(/signing secret/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /save the secret/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/did not save/i);
    expect(screen.getByText(/no secret is set/i)).toBeInTheDocument();
  });
});
