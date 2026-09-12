import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useCreator } from '../api/hooks';
import type { ThemeSummary } from '../api/types';

type Pending = { kind: 'rename' | 'merge' | 'delete'; theme: ThemeSummary } | null;

/**
 * Renaming, merging and deleting a board's themes.
 *
 * All three endpoints have existed since themes shipped and the client only ever read the list —
 * so `MANAGE_THEMES` was a permission a creator could grant for powers nobody could exercise, and
 * a board that had accumulated "Anime" and "anime" had no way back to one name.
 *
 * Behind `MODERATE` + `MANAGE_THEMES`, which is what the API requires. Rendering these controls to
 * a moderator without the permission would be a page whose every request comes back 403.
 */
export function Themes() {
  const { slug = '' } = useParams();
  const { capabilities, loading } = useCreator(slug);
  const [themes, setThemes] = useState<ThemeSummary[] | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const allowed =
    capabilities.moderate && (capabilities.permissions ?? []).includes('MANAGE_THEMES');

  useEffect(() => {
    if (!slug || !allowed) return;
    let cancelled = false;
    api
      .get<{ items: ThemeSummary[] }>(`/creators/${encodeURIComponent(slug)}/themes`)
      .then((body) => !cancelled && setThemes(Array.isArray(body?.items) ? body.items : []))
      .catch(() => !cancelled && setThemes([]));
    return () => {
      cancelled = true;
    };
  }, [slug, allowed]);

  function open(kind: 'rename' | 'merge' | 'delete', theme: ThemeSummary) {
    setPending({ kind, theme });
    setName(theme.name);
    setTarget('');
    setMessage(null);
  }

  const base = `/creators/${encodeURIComponent(slug)}/themes`;

  async function rename(theme: ThemeSummary) {
    try {
      const saved = await api.patch<ThemeSummary>(`${base}/${theme.id}`, { name: name.trim() });
      // Replaced from the response rather than from what was typed: the server trims and
      // re-slugs, so showing the typed value would drift from what is actually stored.
      setThemes((current) =>
        (current ?? []).map((t) => (t.id === theme.id ? { ...t, name: saved.name } : t)),
      );
      setPending(null);
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 409
          ? // The API answers a name clash with 409. Without this a creator is told only that
            // nothing changed, and retypes the same taken name — the board already holds "Anime"
            // and "anime", which is the pair that makes merging exist.
            'A theme with that name already exists.'
          : 'That did not save. Nothing changed.',
      );
    }
  }

  async function merge(theme: ThemeSummary) {
    if (!target) return;
    try {
      await api.post(`${base}/${theme.id}/merge`, { intoId: target });
      // The theme in the path is the one that ceases to exist, and its entries move to the
      // target — so the count moves too rather than quietly disappearing from the page.
      setThemes((current) =>
        (current ?? [])
          .map((t) => (t.id === target ? { ...t, entryCount: t.entryCount + theme.entryCount } : t))
          .filter((t) => t.id !== theme.id),
      );
      setPending(null);
    } catch {
      setMessage('That did not merge. Nothing changed.');
    }
  }

  async function remove(theme: ThemeSummary) {
    try {
      await api.del(`${base}/${theme.id}`);
      setThemes((current) => (current ?? []).filter((t) => t.id !== theme.id));
      setPending(null);
    } catch {
      setMessage('That did not delete. Nothing changed.');
    }
  }

  if (loading) return <p className="p-4">Loading…</p>;
  if (!allowed)
    return (
      <p className="p-4">
        You do not have permission to manage this board&apos;s themes. The creator can grant
        <span className="font-medium"> Manage themes </span>
        from the moderators page.
      </p>
    );
  if (themes === null) return <p className="p-4">Loading…</p>;

  return (
    <section className="max-w-prose">
      <h1 className="text-lg font-medium">Themes</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        <Link to={`/c/${slug}`} className="underline">
          Back to the board
        </Link>
      </p>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        Themes are how a reader narrows the board. They are suggested automatically, which is how a
        board ends up with two that mean the same thing — merging is how it gets back to one.
      </p>

      {themes.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          No themes yet. They appear as entries are added and enriched.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {themes.map((theme) => (
            <li
              key={theme.id}
              className="rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{theme.name}</span>
                  <span className="ml-2 text-slate-600 dark:text-slate-300">
                    {theme.entryCount} {theme.entryCount === 1 ? 'entry' : 'entries'}
                  </span>
                </span>
                <span className="flex gap-2">
                  {/* Named with the theme, not just the verb: a column of buttons all called
                      "Rename" tells a screen-reader user nothing about which one they are on. */}
                  <Action label={`Rename ${theme.name}`} onClick={() => open('rename', theme)}>
                    Rename
                  </Action>
                  <Action label={`Merge ${theme.name}`} onClick={() => open('merge', theme)}>
                    Merge
                  </Action>
                  <Action label={`Delete ${theme.name}`} onClick={() => open('delete', theme)}>
                    Delete
                  </Action>
                </span>
              </div>

              {pending?.theme.id === theme.id ? (
                <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                  {pending.kind === 'rename' ? (
                    <>
                      <label htmlFor="theme-name" className="block text-sm font-medium">
                        New name
                      </label>
                      <input
                        id="theme-name"
                        value={name}
                        maxLength={60}
                        onChange={(event) => setName(event.target.value)}
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
                      />
                      <Confirm onCancel={() => setPending(null)} onConfirm={() => rename(theme)}>
                        Save
                      </Confirm>
                    </>
                  ) : pending.kind === 'merge' ? (
                    <>
                      <label htmlFor="theme-target" className="block text-sm font-medium">
                        Merge into
                      </label>
                      <select
                        id="theme-target"
                        value={target}
                        onChange={(event) => setTarget(event.target.value)}
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
                      >
                        <option value="">Choose a theme…</option>
                        {/* Itself is left out. The server answers that with a 400 because it means
                            the caller confused the two ids, and offering it offers a mistake. */}
                        {themes
                          .filter((other) => other.id !== theme.id)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.name}
                            </option>
                          ))}
                      </select>
                      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                        {/* Merging cannot be undone from here, and the count is the only thing
                            that says how large the change is before it is made. */}
                        <span className="font-medium">{theme.name}</span> stops existing and its{' '}
                        {theme.entryCount} {theme.entryCount === 1 ? 'entry' : 'entries'} move
                        across. This cannot be undone.
                      </p>
                      <Confirm onCancel={() => setPending(null)} onConfirm={() => merge(theme)}>
                        Merge
                      </Confirm>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-slate-600 dark:text-slate-300">
                        Delete <span className="font-medium">{theme.name}</span>? The entries stay
                        on the board; only the theme and its filter go away.
                      </p>
                      <Confirm onCancel={() => setPending(null)} onConfirm={() => remove(theme)}>
                        Delete
                      </Confirm>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {message ? (
        <p role="status" className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function Action({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

function Confirm({
  onCancel,
  onConfirm,
  children,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex gap-2">
      <button
        type="button"
        onClick={onConfirm}
        className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        {children}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded px-3 py-1 text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        Cancel
      </button>
    </div>
  );
}
