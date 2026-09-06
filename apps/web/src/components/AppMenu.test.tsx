import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppMenu } from './AppMenu';

/**
 * The app's own links, collapsed behind one control.
 *
 * They used to sit in a footer on every page, which put a donation ask under everything the
 * reader was trying to do. Tucked into a menu they are still one press away and no longer part
 * of the furniture.
 */
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppMenu />
    </MemoryRouter>,
  );

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /more/i }));
};

describe('AppMenu', () => {
  it('keeps its links out of the page until it is opened', () => {
    at('/');
    expect(screen.queryByRole('menuitem', { name: /support the developers/i })).toBeNull();
  });

  it('offers the support link once opened', async () => {
    at('/');
    await open();

    const link = screen.getByRole('menuitem', { name: /support the developers/i });
    expect(link).toHaveAttribute('href', '/support');
  });

  it('does not link to the page you are already on', async () => {
    // The donation page carried a link to the donation page. A menu item that navigates nowhere
    // is a dead control, so it says where you are instead of offering to take you there.
    at('/support');
    await open();

    expect(screen.queryByRole('menuitem', { name: /support the developers/i })).toBeNull();
    expect(screen.getByText(/support the developers/i)).toHaveAttribute('aria-current', 'page');
  });

  it('is absent on a creator board', async () => {
    // A donation ask on a creator's page competes with that creator's own Patreon ask, in front
    // of an audience that came for them. With nothing else to offer there, the control goes too
    // rather than opening onto an empty menu.
    at('/c/ada-writes');
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull();
  });

  it('closes on Escape', async () => {
    at('/');
    await open();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when something outside it is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppMenu />
        <button type="button">elsewhere</button>
      </MemoryRouter>,
    );
    await open();

    await userEvent.click(screen.getByRole('button', { name: /elsewhere/i }));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
