import type { ReactNode } from 'react';
import type { SessionUser } from '../api/types';

interface LayoutProps {
  user: SessionUser | null;
  loadingSession: boolean;
  onSignOut: () => void;
  children: ReactNode;
}

export function Layout({ user, loadingSession, onSignOut, children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <a
            href="/"
            className="text-lg font-semibold tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            PatreonPlanner
          </a>
          {loadingSession ? null : user ? (
            <div className="flex items-center gap-3">
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
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}
