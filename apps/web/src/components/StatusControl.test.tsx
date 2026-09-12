import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusControl } from './StatusControl';
import { fakeApi } from '../test-support';

describe('StatusControl', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const renderControl = (status: string, onChanged = vi.fn()) => {
    render(
      <StatusControl
        slug="ada-writes"
        recommendationId="rec-1"
        title="Spirited Away"
        status={status}
        onChanged={onChanged}
      />,
    );
    return onChanged;
  };

  it('offers only the legal next statuses', async () => {
    renderControl('PENDING');
    await userEvent.click(screen.getByRole('button', { name: /move “Spirited Away”/i }));
    // The API refuses anything else with a 409; offering it would be a button that cannot work.
    expect(screen.getByRole('menuitem', { name: 'Accepted' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rejected' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Deleted' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Completed' })).not.toBeInTheDocument();
  });

  it('offers restoration for a deleted entry', async () => {
    renderControl('DELETED');
    await userEvent.click(screen.getByRole('button', { name: /move “Spirited Away”/i }));
    expect(screen.getByRole('menuitem', { name: 'Suggestions' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Deleted' })).not.toBeInTheDocument();
  });

  it('posts the change and reports the new status', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/status': {
        id: 'rec-1',
        status: 'ACCEPTED',
      },
    });
    const onChanged = renderControl('PENDING');
    await userEvent.click(screen.getByRole('button', { name: /move “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Accepted' }));
    expect(onChanged).toHaveBeenCalledWith('rec-1', 'ACCEPTED');
  });

  it('explains a refused move and leaves the entry where it was', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/status': new Error('409'),
    });
    const onChanged = renderControl('PENDING');
    await userEvent.click(screen.getByRole('button', { name: /move “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Accepted' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/not allowed/i);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('tells a moderator to reload when someone else moved the entry first', async () => {
    // The same 409 as above, and the opposite remedy. Without the reason code the client called
    // this "not allowed from here", which is false — the move asked for may be perfectly legal
    // from wherever the entry actually is now — and sent moderators looking for a rule problem
    // instead of pressing reload.
    global.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ message: 'changed', reason: 'STALE' }),
        }) as unknown as Response,
    );
    const onChanged = renderControl('PENDING');
    await userEvent.click(screen.getByRole('button', { name: /move “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Accepted' }));

    const message = await screen.findByRole('status');
    expect(message).toHaveTextContent(/someone else moved/i);
    expect(message).not.toHaveTextContent(/not allowed/i);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports a refusal by the server distinctly from a rejected move', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/status': new Error('403'),
    });
    renderControl('PENDING');
    await userEvent.click(screen.getByRole('button', { name: /move “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Accepted' }));
    // Names the permission rather than the role. A 403 here almost always means a moderator who
    // *does* moderate this board and was never granted MOVE_ENTRIES — telling them they do not
    // moderate it sends them looking for the wrong problem.
    expect(await screen.findByRole('status')).toHaveTextContent(/not one of your permissions/i);
  });
});
