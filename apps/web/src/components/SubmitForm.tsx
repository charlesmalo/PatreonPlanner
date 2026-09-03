import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CatalogResult, Recommendation, SubmitResult } from '../api/types';
import { CatalogueSearchField } from './CatalogueSearchField';
import { SimilarEntries } from './SimilarEntries';
import { WatchOrderEditor, type DraftItem } from './WatchOrderEditor';
import { useCatalogSearch } from '../api/use-catalog-search';
import { submitErrorMessage } from './submit-error-message';
import { singlePayload, watchOrderPayload, watchOrderProblem } from './submit-payload';

// Long enough that typing a title is one request, not one per keystroke — the endpoint spends a
// third-party quota.
interface SubmitFormProps {
  slug: string;
  onCreated: (recommendation: Recommendation) => void;
  /** Passed through to the "already on the board?" matches, which offer an upvote. */
  canUpvote?: boolean;
  onUpvoted?: (id: string, count: number, upvoted?: boolean) => void;
}

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
    const problem = watchOrderProblem(customTitle, items);
    if (problem) {
      say(problem, true);
      return;
    }
    await send(watchOrderPayload(customTitle, description, items), () => {
      setCustomTitle('');
      setDescription('');
      setItems([]);
    });
  }

  /**
   * The one place a suggestion is actually posted, shared by both modes.
   *
   * Both used to carry their own copy of busy/message/catch/finally, and the two had already
   * drifted — the watch-order path set its success message directly rather than through `say`,
   * so a success after a failure left the previous message marked as an error and still announced
   * by a screen reader as one.
   */
  async function send(payload: Record<string, unknown>, clear: () => void) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<SubmitResult>(
        `/creators/${encodeURIComponent(slug)}/recommendations`,
        payload,
      );
      say(
        result.duplicate
          ? 'That one is already on the board — upvote it instead.'
          : 'Added. It is pending review.',
        false,
      );
      onCreated(result.recommendation);
      clear();
    } catch (err) {
      say(submitErrorMessage(err), true);
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
    if (!picked && freeTitle.length === 0) {
      say('Search for a title, or give it one yourself.', true);
      return;
    }
    await send(singlePayload(picked, freeTitle, description, url), () => {
      setCustomTitle('');
      setDescription('');
      setUrl('');
      setQuery('');
      setPicked(null);
      setResults([]);
    });
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
        {/* Unmounted, not class-hidden: a watch order has no single work to look up, and a
            leftover pick would be sent as the entry's type. */}
        {mode === 'WATCH_ORDER' ? null : (
          <CatalogueSearchField
            query={query}
            onQueryChange={setQuery}
            picked={picked}
            onPick={setPicked}
            results={results}
            error={searchError}
            searched={searched}
            onUseTyped={(title) => {
              setCustomTitle(title);
              setQuery('');
            }}
          />
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
