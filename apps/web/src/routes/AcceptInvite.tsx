import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { SessionUser } from '../api/types';

interface Accepted {
  role: string;
  creator: { slug: string; displayName: string };
}

export function AcceptInvite({ user }: { user: SessionUser | null }) {
  // From the fragment, not the path: a fragment is never sent to the server, so the token stays
  // out of access logs and Referer headers.
  const token = useLocation().hash.replace(/^#/, '');
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setMessage(null);
    try {
      setAccepted(await api.post<Accepted>('/staff/invites/accept', { token }));
    } catch (error) {
      // One message for every failure: the API deliberately does not distinguish expired from
      // spent from unknown, and neither should this.
      setMessage(
        error instanceof ApiError && error.status === 404
          ? 'That invitation is no longer valid. Ask for a new one.'
          : 'Could not accept that invitation. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Moderator invitation</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          Sign in to accept it. Nobody becomes a moderator without accepting.
        </p>
        <a
          href="/auth/patreon/login"
          className="mt-3 inline-block rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
        >
          Sign in with Patreon
        </a>
      </section>
    );
  }

  if (accepted) {
    return (
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">
          You now moderate {accepted.creator.displayName}
        </h1>
        <Link
          to={`/c/${encodeURIComponent(accepted.creator.slug)}`}
          className="mt-3 inline-block text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
        >
          Go to the board
        </Link>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Moderator invitation</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">
        Accepting lets you review and moderate this creator&rsquo;s board.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={accept}
        className="mt-3 rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
      >
        {busy ? 'Accepting…' : 'Accept'}
      </button>
      {message ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
