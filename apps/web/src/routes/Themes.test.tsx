import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Themes } from './Themes';
import { creator, fakeApi } from '../test-support';

/**
 * Managing themes.
 *
 * Names are matched exactly throughout: the fixture holds "Anime" and "anime" on purpose, because
 * that pair is the reason merging exists, and a case-insensitive matcher finds both controls.
 *
 * `PATCH`, `DELETE` and `POST :id/merge` had all existed since themes shipped, and the client
 * only ever read the list — so `MANAGE_THEMES` was a permission a creator could grant for powers
 * nobody could exercise.
 */
const themes = [
  { id: 't1', name: 'Anime', entryCount: 7 },
  { id: 't2', name: 'anime', entryCount: 2 },
  { id: 't3', name: 'Documentary', entryCount: 0 },
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/c/ada-writes/themes']}>
      <Routes>
        <Route path="/c/:slug/themes" element={<Themes />} />
      </Routes>
    </MemoryRouter>,
  );

describe('Themes', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const withThemes = (extra: object = {}, permissions = ['MANAGE_THEMES']) => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': { moderate: true, permissions },
      'GET /api/v1/creators/ada-writes/themes': { items: themes },
      ...extra,
    });
  };

  it('lists the themes with how much each covers', async () => {
    withThemes();
    renderPage();

    expect(await screen.findByText('Anime')).toBeInTheDocument();
    expect(screen.getByText(/7 entries/i)).toBeInTheDocument();
  });

  it('refuses the page to a moderator without MANAGE_THEMES', async () => {
    // The API requires it. Rendering controls whose every request comes back 403 is a control
    // that looks available and does nothing.
    withThemes({}, ['MOVE_ENTRIES']);
    renderPage();

    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText('Anime')).not.toBeInTheDocument();
  });

  it('renames a theme', async () => {
    withThemes({ 'PATCH /api/v1/creators/ada-writes/themes/t1': { id: 't1', name: 'Animation' } });
    renderPage();
    await screen.findByText('Anime');

    await userEvent.click(screen.getByRole('button', { name: 'Rename Anime' }));
    const field = screen.getByLabelText(/new name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Animation');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('Animation')).toBeInTheDocument();
  });

  it('merges one theme into another and drops the one that goes away', async () => {
    // The case this exists for: a board that has accumulated "Anime" and "anime".
    withThemes({
      'POST /api/v1/creators/ada-writes/themes/t2/merge': { id: 't1', name: 'Anime' },
    });
    renderPage();
    await screen.findByText('anime');

    await userEvent.click(screen.getByRole('button', { name: 'Merge anime' }));
    await userEvent.selectOptions(screen.getByLabelText(/merge into/i), 't1');
    await userEvent.click(screen.getByRole('button', { name: /^merge$/i }));

    await waitFor(() => expect(screen.queryByText('anime')).not.toBeInTheDocument());
    expect(screen.getByText('Anime')).toBeInTheDocument();
  });

  it('does not offer a theme as a merge target for itself', async () => {
    // The server answers that with a 400, because it means the caller confused the two ids.
    // Offering it is offering a mistake.
    withThemes();
    renderPage();
    await screen.findByText('anime');

    await userEvent.click(screen.getByRole('button', { name: 'Merge anime' }));

    const options = await screen.findByLabelText(/merge into/i);
    expect(options).not.toHaveTextContent(/^anime$/);
    expect(within(options).queryByRole('option', { name: 'anime' })).toBeNull();
  });

  it('says how many entries a merge moves before it happens', async () => {
    // Merging is not reversible from here. The count is the only thing that says how big it is.
    withThemes();
    renderPage();
    await screen.findByText('anime');

    await userEvent.click(screen.getByRole('button', { name: 'Merge anime' }));

    // Scoped to the warning: the row itself also says "2 entries", so an unscoped match would
    // pass on the list and prove nothing about what the merge tells you before you do it.
    expect(screen.getByText(/stops existing and its 2 entries move across/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('deletes a theme', async () => {
    withThemes({ 'DELETE /api/v1/creators/ada-writes/themes/t3': {} });
    renderPage();
    await screen.findByText('Documentary');

    await userEvent.click(screen.getByRole('button', { name: 'Delete Documentary' }));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText('Documentary')).not.toBeInTheDocument());
  });

  it('puts a failed rename back rather than showing a name the server refused', async () => {
    withThemes({ 'PATCH /api/v1/creators/ada-writes/themes/t1': new Error('400') });
    renderPage();
    await screen.findByText('Anime');

    await userEvent.click(screen.getByRole('button', { name: 'Rename Anime' }));
    const field = screen.getByLabelText(/new name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'x');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/did not save/i);
    expect(screen.getByText('Anime')).toBeInTheDocument();
  });

  it('says the name is taken rather than only that nothing changed', async () => {
    // The fixture holds "Anime" and "anime" precisely because that pair is why merging exists,
    // so a clash is the ordinary case here rather than an exotic one. The API answers it with
    // 409; without reading that, a creator is told only that nothing happened and retypes the
    // same taken name.
    withThemes({ 'PATCH /api/v1/creators/ada-writes/themes/t1': new Error('409') });
    renderPage();
    await screen.findByText('Anime');

    await userEvent.click(screen.getByRole('button', { name: 'Rename Anime' }));
    const field = screen.getByLabelText(/new name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Documentary');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/already exists/i);
  });
});
