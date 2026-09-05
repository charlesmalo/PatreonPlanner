import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import type { Notification, SessionUser } from '../api/types';
import { NotificationBell } from './NotificationBell';
import { ThemeMenu } from './ThemeMenu';

interface LayoutProps {
  user: SessionUser | null;
  loadingSession: boolean;
  onSignOut: () => void;
  notifications: {
    unreadCount: number;
    items: Notification[];
    loading: boolean;
    failed: boolean;
    open: () => void;
  };
  children: ReactNode;
}

export function Layout({ user, loadingSession, onSignOut, notifications, children }: LayoutProps) {
  // The board only. Its sub-pages — the review queue, staff, tickets — are reading screens and
  // keep the prose width.
  const onABoard = /^\/c\/[^/]+\/?$/.test(useLocation().pathname);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <Link
            to="/"
            className="flex items-center gap-2 text-lg font-semibold tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            {/* Decorative: the link already reads "PatreonPlanner", so naming the mascot again
                would have a screen reader announce the same thing twice. */}
            <img src="/brand/logo.png" alt="" aria-hidden="true" className="h-9 w-auto" />
            {/* The lockup as text rather than a rendered wordmark: it stays selectable, scales to
                any size, and is read aloud as the product's name instead of as pixels. The first
                half inherits the theme's foreground so it works on light and dark alike — a
                literal black would vanish on the dark one. */}
            <span>
              Patreon<span className="text-brand">Planner</span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            {/* Outside the signed-in branch on purpose: choosing a theme is not something anyone
                should have to sign in to do. */}
            <ThemeMenu />
            {loadingSession ? null : user ? (
              <div className="flex items-center gap-3">
                {/* Signed-in only: there is nobody to notify otherwise, and the endpoints 401. */}
                <NotificationBell
                  unreadCount={notifications.unreadCount}
                  items={notifications.items}
                  loading={notifications.loading}
                  failed={notifications.failed}
                  onOpen={notifications.open}
                />
                <span className="text-sm text-slate-600 dark:text-slate-300">
                  {user.fullName ?? 'Signed in'}
                </span>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Sign out
                </button>
              </div>
            ) : (
              // A plain link, not a fetch: this is a top-level navigation into an OAuth redirect,
              // and XHR would break the flow.
              <a
                href="/auth/patreon/login"
                className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
              >
                Sign in with Patreon
              </a>
            )}
          </div>
        </div>
      </header>
      {/*
        Reading width everywhere except the board.
        
        `max-w-3xl` is right for prose — settings, notifications, the landing page — and wrong for
        a board, which had a single column stranded in the middle of a laptop screen with dead
        space either side. Widened here rather than by having the board break out of its own
        container with negative margins, which works until something inside it overflows.
      */}
      <main className={`mx-auto px-4 py-8 ${onABoard ? 'max-w-none' : 'max-w-3xl'}`}>
        {children}
      </main>
      <Footer />
    </div>
  );
}

/**
 * App-level links, deliberately absent from a creator's board.
 *
 * A donation ask on a creator's page competes with that creator's own Patreon ask, in front of an
 * audience that came for them — which creators would reasonably read as monetising their
 * audience. It belongs to the app, so it appears where the app speaks for itself.
 */
function Footer() {
  const onACreatorBoard = useLocation().pathname.startsWith('/c/');
  if (onACreatorBoard) return null;
  return (
    <footer className="mx-auto max-w-3xl px-4 pb-8 text-sm text-slate-500 dark:text-slate-400">
      <Link
        to="/support"
        className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        Support the developers
      </Link>
    </footer>
  );
}
