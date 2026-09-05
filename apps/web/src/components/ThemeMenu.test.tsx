import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeMenu } from './ThemeMenu';
import { THEME_STORAGE_KEY } from '../theme';

/**
 * The theme control.
 *
 * The case worth guarding is **System**. Tailwind followed `prefers-color-scheme` before this
 * existed, so a two-state toggle would have quietly taken that away from everybody who never opens
 * the menu. System is the default and it keeps listening.
 */
describe('ThemeMenu', () => {
  const setSystemDark = (dark: boolean) => {
    const listeners = new Set<() => void>();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: dark && query.includes('dark'),
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }),
    });
    return { fire: () => listeners.forEach((fn) => fn()) };
  };

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    setSystemDark(false);
  });

  const open = async () => {
    await userEvent.click(screen.getByRole('button', { name: /theme/i }));
  };

  it('starts on System, so a reader who never opens it keeps following their machine', async () => {
    render(<ThemeMenu />);
    await open();

    expect(screen.getByRole('menuitemradio', { name: /system/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('puts the dark class on the document when dark is chosen', async () => {
    render(<ThemeMenu />);
    await open();

    await userEvent.click(screen.getByRole('menuitemradio', { name: /dark/i }));

    expect(document.documentElement).toHaveClass('dark');
  });

  it('takes it off again when light is chosen', async () => {
    render(<ThemeMenu />);
    await open();
    await userEvent.click(screen.getByRole('menuitemradio', { name: /dark/i }));

    await open();
    await userEvent.click(screen.getByRole('menuitemradio', { name: /light/i }));

    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('remembers the choice', async () => {
    render(<ThemeMenu />);
    await open();

    await userEvent.click(screen.getByRole('menuitemradio', { name: /dark/i }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('follows the machine while it is set to System', async () => {
    // Not merely at load. A reader on System who switches their operating system to dark in the
    // evening should see the page follow, rather than having to reload to find out.
    const system = setSystemDark(true);
    render(<ThemeMenu />);

    system.fire();

    expect(document.documentElement).toHaveClass('dark');
  });

  it('stops following the machine once a side is chosen', async () => {
    const system = setSystemDark(true);
    render(<ThemeMenu />);
    await open();
    await userEvent.click(screen.getByRole('menuitemradio', { name: /light/i }));

    system.fire();

    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('names the current setting, not just the control', async () => {
    // "Theme" alone leaves somebody pressing the button to discover what it is set to.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<ThemeMenu />);

    expect(screen.getByRole('button', { name: /theme: dark/i })).toBeInTheDocument();
  });

  it('closes on Escape rather than trapping the reader into choosing', async () => {
    render(<ThemeMenu />);
    await open();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('survives storage being unavailable', async () => {
    // Blocked storage throws rather than returning null. A theme preference is not worth taking
    // the page down for.
    const original = window.localStorage.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => render(<ThemeMenu />)).not.toThrow();

    vi.mocked(Storage.prototype.getItem).mockRestore();
    expect(original).toBeDefined();
  });
});
