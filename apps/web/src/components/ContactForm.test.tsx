import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactForm } from './ContactForm';

describe('ContactForm', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stub(ok = true) {
    const sent: unknown[] = [];
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return ok
        ? ({ ok: true, status: 201, json: async () => ({ id: 't1' }) } as Response)
        : ({ ok: false, status: 400 } as Response);
    });
    return sent;
  }

  it('sends general contact with no subject', async () => {
    const sent = stub();
    render(<ContactForm slug="ada-writes" />);

    await userEvent.type(
      screen.getByLabelText(/message the moderators/i),
      'Please cover more anime',
    );
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(sent).toEqual([{ body: 'Please cover more anime' }]));
  });

  it('sends a dispute carrying the entry it is about', async () => {
    const sent = stub();
    render(<ContactForm slug="ada-writes" subjectId="rec-1" subjectTitle="Re:Zero" />);

    await userEvent.type(screen.getByLabelText(/re:zero/i), 'This is season 3, not a duplicate');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(sent).toEqual([{ body: 'This is season 3, not a duplicate', subjectId: 'rec-1' }]),
    );
  });

  it('refuses a message too short to be one, without a request', async () => {
    const sent = stub();
    render(<ContactForm slug="ada-writes" />);

    await userEvent.type(screen.getByLabelText(/message/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(sent).toEqual([]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 10/i);
  });

  it('says so when the server refuses, as an alert rather than a status', async () => {
    // The reason a press did nothing interrupts; a confirmation does not.
    stub(false);
    render(<ContactForm slug="ada-writes" />);

    await userEvent.type(screen.getByLabelText(/message/i), 'Something reasonable here');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send/i);
  });

  it('clears itself after sending, so a second message is not the first again', async () => {
    stub();
    render(<ContactForm slug="ada-writes" />);
    const field = screen.getByLabelText(/message/i);

    await userEvent.type(field, 'Please cover more anime');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(field).toHaveValue(''));
  });
});
