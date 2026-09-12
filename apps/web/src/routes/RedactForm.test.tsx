import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RedactForm } from './RedactForm';
import { fakeApi } from '../test-support';
import type { ReviewQueueItem } from '../api/types';

/**
 * Editing an entry's title and description in place, which is what redaction is here.
 *
 * The 409 test is the point of this file. The API's update is **conditional on the content the
 * moderator was shown** — it answers 409 with "That entry changed while you were editing it" —
 * and this form answered every failure with "Try again". Retrying re-sends the same conditional
 * update against the same changed row, so it fails identically; and worse, it would redact text
 * the moderator can no longer see. Reloading is the only thing that helps.
 */
const item: ReviewQueueItem = {
  id: 'rec-1',
  customTitle: 'Spirited Away',
  description: 'A classic.',
  status: 'PENDING',
  upvoteCount: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  submittedBy: { id: 'u1', fullName: 'Grace', avatarUrl: null },
  openFlagCount: 0,
  flags: [],
  watchOrderItems: [],
  notes: [],
} as unknown as ReviewQueueItem;

const renderForm = () => {
  const onDone = vi.fn();
  render(<RedactForm slug="ada-writes" item={item} onDone={onDone} />);
  return onDone;
};

const editTitle = async (text: string) => {
  const field = screen.getByLabelText(/title/i);
  await userEvent.clear(field);
  await userEvent.type(field, text);
  await userEvent.click(screen.getByRole('button', { name: /save redaction/i }));
};

describe('RedactForm', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('saves a redaction and hands the change back to the queue', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/recommendations/rec-1': {
        customTitle: 'Redacted',
        description: 'A classic.',
      },
    });
    const onDone = renderForm();

    await editTitle('Redacted');

    expect(onDone).toHaveBeenCalledWith({ customTitle: 'Redacted', description: 'A classic.' });
  });

  it('sends nothing at all when nothing was edited', async () => {
    // The API rejects an empty PATCH rather than writing an audit row for an edit that did not
    // happen, so the form must not send one.
    const fetch = fakeApi({});
    global.fetch = fetch;
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /save redaction/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/nothing changed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says the entry changed underneath rather than telling anyone to try again', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/recommendations/rec-1': new Error('409'),
    });
    const onDone = renderForm();

    await editTitle('Redacted');

    const message = await screen.findByRole('status');
    expect(message).toHaveTextContent(/changed/i);
    expect(message).not.toHaveTextContent(/try again/i);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('suggests rewording when the text itself was rejected', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/recommendations/rec-1': new Error('400'),
    });
    renderForm();

    await editTitle('Redacted');

    expect(await screen.findByRole('status')).toHaveTextContent(/rewording/i);
  });

  it('names the missing permission on a 403', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/recommendations/rec-1': new Error('403'),
    });
    renderForm();

    await editTitle('Redacted');

    expect(await screen.findByRole('status')).toHaveTextContent(/not one of your permissions/i);
  });
});
