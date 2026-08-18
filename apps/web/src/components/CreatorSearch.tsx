import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { DiscoveredCreator } from '../api/types';

/** Matches the submission form: one request per pause in typing, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 500;
/** Below this a query matches most boards, which is a listing rather than a search. */
const MIN_QUERY = 2;

interface CreatorSearchProps {
  signedIn: boolean;
}

export function CreatorSearch({ signedIn }: CreatorSearchProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DiscoveredCreator[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY) {
      setItems(null);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ items: DiscoveredCreator[] }>(
          `/creators?q=${encodeURIComponent(query.trim())}`,
        );
        // Ignore a response a later keystroke has superseded, or results flicker backwards.
        if (mine !== seq.current) return;
        setItems(res.items);
      } catch {
        if (mine !== seq.current) return;
        setItems([]);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  async function toggleFavorite(creator: DiscoveredCreator) {
    // Optimistic: the control is a toggle, and waiting a round-trip to redraw it feels broken.
    setItems(
      (current) =>
        current?.map((item) =>
          item.id === creator.id ? { ...item, favorited: !item.favorited } : item,
        ) ?? current,
    );
    try {
      const path = `/creators/${encodeURIComponent(creator.slug)}/favorite`;
      if (creator.favorited) await api.del(path);
      else await api.post(path);
    } catch {
      // Put it back rather than leave the control lying about what the server holds.
      setItems(
        (current) =>
          current?.map((item) =>
            item.id === creator.id ? { ...item, favorited: creator.favorited } : item,
          ) ?? current,
      );
    }
  }

  return (
    <div>
      <label htmlFor="creator-search" className="block text-sm font-medium">
        Find a creator
      </label>
      <input
        id="creator-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="e.g. Movie Night"
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
      />

      {items === null ? null : items.length === 0 ? (
        <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          {busy ? 'Searching…' : 'No creators match that.'}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
          {items.map((creator) => (
            <li key={creator.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <Link
                  to={`/c/${creator.slug}`}
                  className="font-medium underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  {creator.displayName}
                </Link>
                {/* Why this one is near the top, in a word. */}
                {creator.favorited ? (
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">Favourite</span>
                ) : creator.supported ? (
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                    You support this
                  </span>
                ) : null}
              </span>
              {/* Signed out, the endpoint would 401, so the control would be a dead end. */}
              {signedIn ? (
                <button
                  type="button"
                  onClick={() => toggleFavorite(creator)}
                  aria-pressed={creator.favorited}
                  aria-label={`${creator.favorited ? 'Unfavourite' : 'Favourite'} ${creator.displayName}`}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {creator.favorited ? '★' : '☆'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
