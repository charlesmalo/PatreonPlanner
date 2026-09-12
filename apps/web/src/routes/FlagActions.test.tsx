import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlagActions } from './FlagActions';
import { fakeApi } from '../test-support';

/**
 * Resolving the report attached to an entry.
 *
 * The 409 test is the point of this file. `PATCH /flags/:id` answers 409 with "That report has
 * already been handled" — another moderator got there first, or this moderator double-clicked —
 * and the component answered every failure with "Try again". 409 is precisely the status where
 * trying again cannot work: the report is resolved, and no number of retries changes that.
 */
const renderActions = () => {
  const onResolved = vi.fn();
  render(<FlagActions slug="ada-writes" flagId="flag-1" onResolved={onResolved} />);
  return onResolved;
};

describe('FlagActions', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves a report and tells the queue', async () => {
    global.fetch = fakeApi({ 'PATCH /api/v1/creators/ada-writes/flags/flag-1': {} });
    const onResolved = renderActions();

    await userEvent.click(screen.getByRole('button', { name: /uphold/i }));

    expect(onResolved).toHaveBeenCalled();
  });

  it('says a report was already handled rather than telling anyone to try again', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/flags/flag-1': new Error('409'),
    });
    const onResolved = renderActions();

    await userEvent.click(screen.getByRole('button', { name: /uphold/i }));

    const message = await screen.findByRole('status');
    expect(message).toHaveTextContent(/already been handled/i);
    expect(message).not.toHaveTextContent(/try again/i);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('names the missing permission on a 403', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/flags/flag-1': new Error('403'),
    });
    renderActions();

    await userEvent.click(screen.getByRole('button', { name: /uphold/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/not one of your permissions/i);
  });

  it('offers try again for a failure that really might succeed next time', async () => {
    global.fetch = fakeApi({
      'PATCH /api/v1/creators/ada-writes/flags/flag-1': new Error('500'),
    });
    renderActions();

    await userEvent.click(screen.getByRole('button', { name: /uphold/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/try again/i);
  });
});
