import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

/**
 * The app's own links, collapsed behind one control.
 *
 * These used to sit in a footer rendered under every page, which meant a donation ask sat
 * underneath everything the reader was actually there to do. Behind a menu they are still one
 * press away, and no longer part of the furniture.
 *
 * Built on the same shape as `ThemeMenu` — a button, a `role="menu"`, Escape and outside-click to
 * close — because two header controls that behave differently is worse than either behaviour.
 */

interface Item {
  to: string;
  label: string;
  /** Asks the API for something only a session can answer, so it is no use to a visitor. */
  needsSession?: boolean;
}

/**
 * `/premium` and `/carry-over` are here because nothing else in the client linked to them. A
 * search for either path found the route definition and the page, and no `to=` anywhere — so both
 * were complete, tested pages reachable only by typing the URL. They belong in this menu for the
 * same reason the donation link does: they are the app's own, not a board's.
 */
const ITEMS: Item[] = [
  { to: '/premium', label: 'Premium', needsSession: true },
  { to: '/carry-over', label: 'Suggest a list to other boards', needsSession: true },
  { to: '/support', label: 'Support the developers' },
];

interface AppMenuProps {
  signedIn: boolean;
}

export function AppMenu({ signedIn }: AppMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  // A donation ask on a creator's page competes with that creator's own Patreon ask, in front of
  // an audience that came for them. Nothing else in this menu belongs on a board either, so the
  // control goes rather than opening onto an empty menu.
  const onACreatorBoard = pathname.startsWith('/c/');

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Closes on navigation. Without it the menu hangs over the page it just moved to, which reads
  // as the press having done nothing.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // A visitor is offered only what works without a session; the rest would open a page that can
  // do nothing but report a failure.
  const visible = ITEMS.filter((item) => signedIn || !item.needsSession);

  if (onACreatorBoard || visible.length === 0) return null;

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="rounded border border-slate-300 px-2 py-1.5 text-sm leading-none hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="More"
          className="absolute right-0 z-20 mt-1 w-56 rounded border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900"
        >
          {visible.map((item) =>
            // The donation page carried a link to the donation page. A menu item that navigates
            // nowhere is a dead control, so where the reader already is says so instead.
            pathname === item.to ? (
              <span
                key={item.to}
                aria-current="page"
                className="block rounded px-2 py-1.5 text-sm text-slate-500 dark:text-slate-400"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.to}
                to={item.to}
                role="menuitem"
                className="block rounded px-2 py-1.5 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
              >
                {item.label}
              </Link>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
