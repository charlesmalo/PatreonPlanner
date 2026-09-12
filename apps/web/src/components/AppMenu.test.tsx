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
const at = (path: string, signedIn = true) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppMenu signedIn={signedIn} />
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

  it('offers the two pages nothing else in the app links to', async () => {
    // Both were reachable only by typing the URL. `/premium` is where somebody buys it and sees
    // what they already have; `/carry-over` puts the same handful of titles in front of every
    // board they support. Neither appeared in any `to=` anywhere in the client — the only
    // mentions were the route definitions and the pages themselves.
    at('/');
    await open();

    expect(screen.getByRole('menuitem', { name: /premium/i })).toHaveAttribute('href', '/premium');
    expect(screen.getByRole('menuitem', { name: /other boards/i })).toHaveAttribute(
      'href',
      '/carry-over',
    );
  });

  it('offers a signed-out reader only what works signed out', async () => {
    // Both new pages ask the API for something that needs a session, so offering them to a
    // visitor leads to a page that can only report a failure. The donation page has no such
    // requirement and is exactly the thing a stranger might want.
    at('/', false);
    await open();

    expect(screen.getByRole('menuitem', { name: /support the developers/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /premium/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /other boards/i })).toBeNull();
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
        <AppMenu signedIn />
        <button type="button">elsewhere</button>
      </MemoryRouter>,
    );
    await open();

    await userEvent.click(screen.getByRole('button', { name: /elsewhere/i }));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
