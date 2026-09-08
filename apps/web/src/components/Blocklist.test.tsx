import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Blocklist } from './Blocklist';
import { fakeApi } from '../test-support';

/**
 * The creator's own blocklist.
 *
 * Every part of this existed server-side — list, add, remove, normalisation, the conflict on a
 * duplicate, and enforcement in the moderation pipeline — and no page in the app called any of it.
 * A creator could not add a single word.
 */
const word = (id: string, pattern: string, action = 'BLOCK') => ({
  id,
  pattern,
  action,
  createdAt: '2026-09-01T00:00:00.000Z',
});

describe('Blocklist', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const withList = (items: object[], extra: object = {}) => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/blocklist': { items },
      ...extra,
    });
  };

  it('lists the words already on it', async () => {
    withList([word('1', 'spoilers'), word('2', 'leak', 'FLAG')]);
    render(<Blocklist slug="ada-writes" />);

    expect(await screen.findByText('spoilers')).toBeInTheDocument();
    expect(screen.getByText('leak')).toBeInTheDocument();
  });

  it('says the list is empty rather than showing nothing at all', async () => {
    withList([]);
    render(<Blocklist slug="ada-writes" />);

    expect(await screen.findByText(/nothing on the list/i)).toBeInTheDocument();
  });

  it('warns that a word is matched anywhere inside another', async () => {
    // The trap this feature carries: it is a substring test, so a short word catches far more
    // than a creator expects. Saying so is the difference between a tool and a surprise.
    withList([]);
    render(<Blocklist slug="ada-writes" />);

    expect(await screen.findByText(/assassin/i)).toBeInTheDocument();
  });

  it('does not report a failed load as an empty list', async () => {
    // The trap in the obvious version: catching the error and showing "nothing on the list" tells
    // a creator their words are gone, and invites them to re-add ones the server already has.
    global.fetch = fakeApi({ 'GET /api/v1/creators/ada-writes/blocklist': new Error('500') });
    render(<Blocklist slug="ada-writes" />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing on the list/i)).not.toBeInTheDocument();
  });

  it('adds a word and shows it without a reload', async () => {
    withList([], {
      'POST /api/v1/creators/ada-writes/blocklist': word('9', 'spoilers'),
    });
    render(<Blocklist slug="ada-writes" />);
    await screen.findByText(/nothing on the list/i);

    await userEvent.type(screen.getByLabelText(/word or phrase/i), 'spoilers');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(await screen.findByText('spoilers')).toBeInTheDocument();
  });

  it('says a duplicate is already there, rather than that something went wrong', async () => {
    withList([word('1', 'spoilers')], {
      'POST /api/v1/creators/ada-writes/blocklist': new Error('409'),
    });
    render(<Blocklist slug="ada-writes" />);
    await screen.findByText('spoilers');

    await userEvent.type(screen.getByLabelText(/word or phrase/i), 'Spoilers');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/already on the list/i);
  });

  it('does not send a word too short for the server to accept', async () => {
    // The server takes 2 to 100 characters. Sending one character produces a 400 that reads like
    // a fault in the page rather than an answer to what was typed.
    const fetchMock = fakeApi({ 'GET /api/v1/creators/ada-writes/blocklist': { items: [] } });
    global.fetch = fetchMock;
    render(<Blocklist slug="ada-writes" />);
    await screen.findByText(/nothing on the list/i);

    await userEvent.type(screen.getByLabelText(/word or phrase/i), 'a');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(await screen.findByRole('status')).toHaveTextContent(/at least two characters/i);
  });

  it('removes a word', async () => {
    withList([word('1', 'spoilers')], {
      'DELETE /api/v1/creators/ada-writes/blocklist/1': {},
    });
    render(<Blocklist slug="ada-writes" />);
    await screen.findByText('spoilers');

    await userEvent.click(screen.getByRole('button', { name: /remove spoilers/i }));

    await waitFor(() => expect(screen.queryByText('spoilers')).not.toBeInTheDocument());
  });

  it('can add a word that flags rather than blocks', async () => {
    // Two different powers: one refuses the submission, the other sends it to the queue. A list
    // that only blocks makes a creator choose between silence and nothing.
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes/blocklist': { items: [] },
      'POST /api/v1/creators/ada-writes/blocklist': word('9', 'maybe', 'FLAG'),
    });
    global.fetch = fetchMock;
    render(<Blocklist slug="ada-writes" />);
    await screen.findByText(/nothing on the list/i);

    await userEvent.type(screen.getByLabelText(/word or phrase/i), 'maybe');
    await userEvent.selectOptions(screen.getByLabelText(/what happens/i), 'FLAG');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));

    await screen.findByText('maybe');
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ pattern: 'maybe', action: 'FLAG' });
  });
});
