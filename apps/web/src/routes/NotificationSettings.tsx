import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useThemes } from '../api/hooks';

/**
 * The columns a reader can be told about, in board order rather than alphabetically — the page
 * reads as the board reads.
 *
 * DELETED and REJECTED are absent for the reason the API refuses them: they are off the board, so
 * offering them would promise notifications about entries that cannot be opened.
 */
const COLUMNS: Array<[string, string]> = [
  ['PENDING', 'Suggestions'],
  ['ACCEPTED', 'Accepted'],
  ['ACTIVE', 'Now playing'],
  ['COMPLETED', 'Completed'],
];

interface Preferences {
  statuses: string[];
  emailDigest: boolean;
  themeIds: string[];
  isDefault: boolean;
  canCustomise: boolean;
}

/**
 * How much of a board's news reaches you.
 *
 * Being notified is free; choosing what you are notified about is not. The controls are therefore
 * disabled with a reason rather than hidden — the opposite of the link-review controls, which are
 * hidden because the API refuses that reader outright. Here the reader is eligible to buy the
 * thing, and a control that simply vanishes teaches them nothing.
 */
export function NotificationSettings() {
  const { slug = '' } = useParams();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const themes = useThemes(slug, true);

  const path = `/creators/${encodeURIComponent(slug)}/notification-preferences`;

  useEffect(() => {
    let cancelled = false;
    api
      .get<Preferences>(path)
      .then((loaded) => {
        if (!cancelled) setPrefs(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  async function save(statuses: string[], themeIds: string[] = prefs?.themeIds ?? []) {
    if (!prefs) return;
    const previous = prefs;
    // Optimistic, then reconciled — the pattern the pick control already follows. A checkbox that
    // goes on claiming a change the server refused is worse than one that flickers.
    setPrefs({ ...prefs, statuses, themeIds, isDefault: false });
    setBusy(true);
    try {
      await api.put(path, { statuses, themeIds });
    } catch {
      setPrefs(previous);
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <p className="p-4">Could not load your notification settings.</p>;
  if (!prefs) return <p className="p-4">Loading…</p>;

  const { statuses, themeIds, isDefault, canCustomise } = prefs;

  async function saveDigest(next: boolean) {
    const previous = prefs as Preferences;
    setPrefs({ ...previous, emailDigest: next });
    setBusy(true);
    try {
      await api.put('/me/email-digest', { enabled: next });
    } catch {
      setPrefs(previous);
    } finally {
      setBusy(false);
    }
  }
  const toggleTheme = (id: string) =>
    save(statuses, themeIds.includes(id) ? themeIds.filter((t) => t !== id) : [...themeIds, id]);

  return (
    <section className="mx-auto max-w-lg p-4">
      <h1 className="text-lg font-medium">What this board tells you</h1>

      {isDefault ? (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Using the default: you hear when something starts and when it finishes.
        </p>
      ) : statuses.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          You hear nothing from this board.
        </p>
      ) : null}

      {canCustomise ? null : (
        <p className="mt-2 rounded bg-slate-100 p-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          You are notified either way. Choosing <strong>which</strong> moves reach you is part of{' '}
          {/* Unlike a permission a moderator has to be granted, this reader is eligible to buy the
              thing — and was told its name and left to find the page on their own. Nothing in the
              client linked to /premium at all. */}
          <Link
            to="/premium"
            className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            premium
          </Link>
          .
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {COLUMNS.map(([value, label]) => (
          <li key={value}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={statuses.includes(value)}
                disabled={!canCustomise || busy}
                onChange={() =>
                  save(
                    statuses.includes(value)
                      ? statuses.filter((s) => s !== value)
                      : [...statuses, value],
                  )
                }
              />
              <span>When something moves to {label}</span>
            </label>
          </li>
        ))}
      </ul>

      {themes.length > 0 ? (
        <>
          <h2 className="mt-5 text-sm font-medium">Which of it you care about</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {themeIds.length === 0
              ? 'Everything on this board. Pick some to narrow it.'
              : 'Only these. Entries with no theme of their own will not reach you.'}
          </p>
          <ul className="mt-2 space-y-2">
            {themes.map((theme) => (
              <li key={theme.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={themeIds.includes(theme.id)}
                    disabled={!canCustomise || busy}
                    onChange={() => toggleTheme(theme.id)}
                  />
                  <span>{theme.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="mt-5 text-sm font-medium">By email</h2>
      <label className="mt-1 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.emailDigest}
          disabled={busy}
          onChange={() => saveDigest(!prefs.emailDigest)}
          className="mt-1"
        />
        <span>
          Send me one email a day with what moved.{' '}
          <span className="text-slate-500 dark:text-slate-400">
            Off unless you ask — your address came from Patreon so you could sign in, not so we
            could write to you. Every email has a link to stop them.
          </span>
        </span>
      </label>

      <button
        type="button"
        onClick={() => save([])}
        disabled={!canCustomise || busy || statuses.length === 0}
        className="mt-4 rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Turn all of these off
      </button>
    </section>
  );
}
