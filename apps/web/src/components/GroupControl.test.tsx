import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupControl } from './GroupControl';
import { fakeApi, recommendation } from '../test-support';

const entry = recommendation({ id: 'a', customTitle: 'Spirited Away' });
const target = recommendation({ id: 'b', customTitle: 'Princess Mononoke' });

const renderControl = (props: Partial<Parameters<typeof GroupControl>[0]> = {}) => {
  const onChanged = vi.fn();
  render(
    <GroupControl
      slug="ada-writes"
      entry={entry}
      targets={[target]}
      onChanged={onChanged}
      {...props}
    />,
  );
  return onChanged;
};

const openMenu = async () =>
  userEvent.click(screen.getByRole('button', { name: /group “Spirited Away”/i }));

describe('GroupControl', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('groups an entry into the one chosen from the menu', async () => {
    const fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/a/group': {},
    });
    global.fetch = fetch;
    const onChanged = renderControl();

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Princess Mononoke/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [, init] = fetch.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ intoId: 'b' });
  });

  it('offers Ungroup instead of targets once an entry is in a staff group', async () => {
    const fetch = fakeApi({
      'DELETE /api/v1/creators/ada-writes/recommendations/a/group': {},
    });
    global.fetch = fetch;
    const onChanged = renderControl({
      entry: { ...entry, parentId: 'b', parentSource: 'STAFF' },
    });

    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /Princess Mononoke/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /ungroup/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetch.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('never offers Ungroup for a nesting the catalogue implied', async () => {
    // `DELETE :id/group` returns early on one of these, so the button would do nothing. This is
    // the whole reason the card carries `parentSource` rather than only `parentId`.
    renderControl({ entry: { ...entry, parentId: 'b', parentSource: 'CATALOGUE' } });

    await openMenu();

    expect(screen.queryByRole('menuitem', { name: /ungroup/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Princess Mononoke/i })).toBeInTheDocument();
  });

  it('renders nothing when there is nowhere to go and nothing to undo', async () => {
    // An empty menu is a control that opens onto nothing.
    renderControl({ targets: [] });

    expect(
      screen.queryByRole('button', { name: /group “Spirited Away”/i }),
    ).not.toBeInTheDocument();
  });

  it('still renders for a grouped entry with no targets, because Ungroup is the point', async () => {
    renderControl({ targets: [], entry: { ...entry, parentId: 'b', parentSource: 'STAFF' } });

    await openMenu();

    expect(screen.getByRole('menuitem', { name: /ungroup/i })).toBeInTheDocument();
  });

  it('names the permission on a 403 rather than the role', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/a/group': new Error('403'),
    });
    renderControl();

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Princess Mononoke/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/not one of your permissions/i);
  });

  it('does not say “try again” on a conflict, where trying again cannot work', async () => {
    // The menu is pre-filtered, so a 409 means somebody grouped one of the two while it was open.
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/a/group': new Error('409'),
    });
    const onChanged = renderControl();

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Princess Mononoke/i }));

    const message = await screen.findByRole('status');
    expect(message).toHaveTextContent(/reload the board/i);
    expect(message).not.toHaveTextContent(/try again/i);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
