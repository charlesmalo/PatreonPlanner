import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { CatalogResult, Recommendation, SubmitResult } from '../api/types';
import { SimilarEntries } from './SimilarEntries';
import { WatchOrderEditor, type DraftItem } from './WatchOrderEditor';
import { useCatalogSearch } from '../api/use-catalog-search';

// Long enough that typing a title is one request, not one per keystroke — the endpoint spends a
// third-party quota.
interface SubmitFormProps {
  slug: string;
  onCreated: (recommendation: Recommendation) => void;
  /** Passed through to the "already on the board?" matches, which offer an upvote. */
  canUpvote?: boolean;
  onUpvoted?: (id: string, count: number, upvoted?: boolean) => void;
}

/** A collection is a franchise; everything else the catalogue returns is a single work. */
const TYPE_FOR_MEDIA: Record<CatalogResult['mediaType'], 'MOVIE' | 'SHOW' | 'FRANCHISE'> = {
  MOVIE: 'MOVIE',
  TV: 'SHOW',
  COLLECTION: 'FRANCHISE',
};

const MAX_ITEMS = 50;

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

export function SubmitForm({ slug, onCreated, canUpvote = false, onUpvoted }: SubmitFormProps) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CatalogResult | null>(null);
  const {
    results,
    error: searchError,
    searched,
    setResults,
    setError: setSearchError,
  } = useCatalogSearch(slug, query, picked !== null);
  /** Whether a search has come back for what is currently typed — not merely that it is empty. */
  const [customTitle, setCustomTitle] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Whether the last message is the reason nothing happened. An alert interrupts a screen reader
   * and a status does not — and "why did my press do nothing" is exactly the case worth
   * interrupting for. A confirmation is not.
   */
  const [messageIsError, setMessageIsError] = useState(false);

  const say = (text: string, isError: boolean) => {
    setMessage(text);
    setMessageIsError(isError);
  };
  const [mode, setMode] = useState<'SINGLE' | 'WATCH_ORDER'>('SINGLE');
  const [items, setItems] = useState<DraftItem[]>([]);

  /**
   * A watch order is composed rather than looked up: it has no upstream identity, so its outer
   * title is free text and its steps are the content.
   */
  async function submitWatchOrder() {
    // Blank steps are the natural result of one "Add a step" too many; dropping them beats a 400.
    const filled = items.filter(
      (item) => item.tmdbId !== undefined || (item.customTitle ?? '').trim().length > 0,
    );
    if (customTitle.trim().length === 0) {
      say('Give the watch order a name.', true);
      return;
    }
    if (filled.length === 0) {
      say('A watch order needs at least one step.', true);
      return;
    }
    // Mirrors the DTO's cap so the mistake costs no round-trip; the server's 400 still wins.
    if (filled.length > MAX_ITEMS) {
      say('A watch order can have at most fifty steps.', true);
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<SubmitResult>(
        `/creators/${encodeURIComponent(slug)}/recommendations`,
        {
          type: 'WATCH_ORDER',
          customTitle: customTitle.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          // Order in the array *is* the order; the server numbers from it.
          items: filled.map((item) =>
            item.tmdbId !== undefined
              ? {
                  tmdbId: item.tmdbId,
                  mediaType: item.mediaType,
                  ...(item.note?.trim() ? { note: item.note.trim() } : {}),
                }
              : {
                  customTitle: (item.customTitle as string).trim(),
                  ...(item.note?.trim() ? { note: item.note.trim() } : {}),
                },
          ),
        },
      );
      setMessage(
        result.duplicate
          ? 'That one is already on the board — upvote it instead.'
          : 'Added. It is pending review.',
      );
      onCreated(result.recommendation);
      setCustomTitle('');
      setDescription('');
      setItems([]);
    } catch (err) {
      say(messageFor(err), true);
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === 'WATCH_ORDER') return submitWatchOrder();
    // The search box counts as a title when nothing was picked from it. Someone who types a name,
    // sees no suggestions because the catalogue does not carry it, and presses Suggest means that
    // name — refusing because they typed it in the first box rather than the second is the form
    // being pedantic about its own internals.
    const freeTitle = customTitle.trim() || (picked ? '' : query.trim());
    // Mirrors the DTO's bounds so the common mistake costs no round-trip — a convenience, not a
    // control; the server's 400 is still rendered when it disagrees.
    if (!picked && freeTitle.length === 0) {
      say('Search for a title, or give it one yourself.', true);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<SubmitResult>(
        `/creators/${encodeURIComponent(slug)}/recommendations`,
        picked
          ? {
              // The canonical name comes from the catalogue, so none is sent.
              type: TYPE_FOR_MEDIA[picked.mediaType],
              tmdbId: picked.tmdbId,
              ...(description.trim() ? { description: description.trim() } : {}),
            }
          : {
              type: 'EXTERNAL_LINK',
              customTitle: freeTitle,
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(url.trim() ? { links: [{ url: url.trim() }] } : {}),
            },
      );
      if (result.duplicate) {
        say('That one is already on the board — upvote it instead.', false);
      } else {
        say('Added. It is pending review.', false);
      }
      onCreated(result.recommendation);
      setCustomTitle('');
      setDescription('');
      setUrl('');
      setQuery('');
      setPicked(null);
      setResults([]);
    } catch (err) {
      say(messageFor(err), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <h2 className="font-medium">Suggest something</h2>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium">What kind of suggestion?</legend>
        <div className="mt-1 flex gap-4">
          {(
            [
              ['SINGLE', 'A film, show or franchise'],
              ['WATCH_ORDER', 'A watch order'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="rec-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 space-y-3">
        {/* Unmounted, not class-hidden: a watch order has no single work to look up, and a
            leftover pick would be sent as the entry's type. */}
        {mode === 'WATCH_ORDER' ? null : (
          <div>
            <label htmlFor="rec-search" className="block text-sm font-medium">
              Search films and shows
            </label>
            {picked ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800">
                  {picked.name}
                  {picked.year ? ` (${picked.year})` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  id="rec-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. Spirited Away"
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
                />
                {results.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {results.slice(0, 5).map((result) => (
                      <li key={`${result.mediaType}-${result.tmdbId}`}>
                        <button
                          type="button"
                          onClick={() => setPicked(result)}
                          className="w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
                        >
                          {result.name}
                          {result.year ? ` (${result.year})` : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {searchError ? (
                  <p role="status" className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {searchError}
                  </p>
                ) : null}
                {/* Only once a search has actually come back empty — saying "nothing matches"
                    while the reader is still typing the second letter would be wrong and
                    would flicker. */}
                {searched && !searchError && results.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    Nothing in the catalogue matches that.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setCustomTitle(query.trim());
                        setQuery('');
                      }}
                      className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    >
                      Add “{query.trim()}” anyway
                    </button>
                  </p>
                ) : null}
              </>
            )}
          </div>
        )}
        <div className={picked && mode !== 'WATCH_ORDER' ? 'hidden' : undefined}>
          <label htmlFor="rec-title" className="block text-sm font-medium">
            {mode === 'WATCH_ORDER'
              ? 'What to call it'
              : '…or add something the catalogue does not have'}
          </label>
          <input
            id="rec-title"
            value={customTitle}
            maxLength={MAX_TITLE}
            onChange={(e) => setCustomTitle(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
          {/* Only for a free-text title. A picked catalogue result is already covered exactly by
              the canonical de-dupe, which answers 200 with the existing entry — a fuzzy guess
              beside it would be noise. */}
          {picked ? null : (
            <SimilarEntries
              slug={slug}
              query={customTitle}
              canUpvote={canUpvote}
              onCount={onUpvoted ?? (() => undefined)}
            />
          )}
        </div>
        {mode === 'WATCH_ORDER' ? (
          <WatchOrderEditor slug={slug} items={items} onChange={setItems} />
        ) : null}
        <div>
          <label htmlFor="rec-description" className="block text-sm font-medium">
            Why? <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </label>
          <textarea
            id="rec-description"
            value={description}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        {/* Unmounted rather than hidden in watch-order mode: submitWatchOrder never sends links,
            so a URL typed here would be silently dropped. */}
        {mode === 'WATCH_ORDER' ? null : (
          <div className={picked ? 'hidden' : undefined}>
            <label htmlFor="rec-url" className="block text-sm font-medium">
              Link{' '}
              <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
            </label>
            <input
              id="rec-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        )}
      </div>
      <button
        type="submit"
        disabled={busy}
        className="mt-4 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-100 dark:text-slate-900"
      >
        {busy ? 'Sending…' : 'Suggest'}
      </button>
      {message ? (
        <p
          role={messageIsError ? 'alert' : 'status'}
          className="mt-3 text-sm text-slate-600 dark:text-slate-300"
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

function messageFor(error: unknown): string {
  // A timeout is the one refusal that carries a time, and the time is the only part the user can
  // act on. Nothing is said about why — design §9 wants no probing of the rules.
  if (error instanceof ApiError && error.status === 403 && error.retryAt) {
    const when = new Date(error.retryAt);
    if (!Number.isNaN(when.getTime())) {
      return `You cannot suggest anything until ${when.toLocaleString()}.`;
    }
  }
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.status) {
    case 429:
      return 'You have suggested recently — try again a little later.';
    case 400:
      return 'That suggestion was rejected. Try rewording it.';
    case 403:
      return 'Suggesting is for patrons at the required tier.';
    case 401:
      return 'Sign in to suggest something.';
    default:
      return 'Something went wrong. Try again.';
  }
}
