import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useCreator, useReviewQueue } from '../api/hooks';
import type { ReviewQueueItem } from '../api/types';
import { STATUS_LABELS, StatusControl } from '../components/StatusControl';
import { NoteEditor } from '../components/NoteEditor';
import { NoteList } from '../components/NoteList';
import { WatchOrderList } from '../components/WatchOrderList';

const REASON_LABELS: Record<string, string> = {
  SPAM: 'Spam or advertising',
  HARASSMENT: 'Harassment or hate',
  SEXUAL_CONTENT: 'Sexual content',
  OFF_TOPIC: 'Off topic',
  DUPLICATE: 'Already on the board',
  OTHER: 'Something else',
};

export function ReviewQueue() {
  const { slug = '' } = useParams();
  const { creator } = useCreator(slug);
  const queue = useReviewQueue(slug);

  if (queue.loading) {
    return <p role="status">Loading the review queue…</p>;
  }

  if (queue.error) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-300">
        {queue.error.status === 403 || queue.error.status === 401
          ? 'You do not moderate this board.'
          : 'Could not load the review queue. Try again.'}
      </p>
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">
        Review queue{creator ? ` — ${creator.displayName}` : ''}
      </h1>
      <Link
        to={`/c/${encodeURIComponent(slug)}`}
        className="mt-1 inline-block text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
      >
        Back to the board
      </Link>

      {queue.items.length === 0 ? (
        <p className="mt-6 text-slate-600 dark:text-slate-300">Nothing to review right now.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {queue.items.map((item) => (
            <QueueRow
              key={item.id}
              slug={slug}
              item={item}
              onUpdate={queue.update}
              onFlagResolved={queue.dropFlag}
            />
          ))}
        </ul>
      )}

      {queue.hasMore ? (
        <button
          type="button"
          onClick={queue.loadMore}
          disabled={queue.loadingMore}
          className="mt-4 rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {queue.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
      {queue.moreError ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {queue.moreError}
        </p>
      ) : null}
    </section>
  );
}

interface QueueRowProps {
  slug: string;
  item: ReviewQueueItem;
  onUpdate: (id: string, changes: Partial<ReviewQueueItem>) => void;
  onFlagResolved: (recommendationId: string, flagId: string) => void;
}

function QueueRow({ slug, item, onUpdate, onFlagResolved }: QueueRowProps) {
  const [redacting, setRedacting] = useState(false);

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Text, never markup: every field below is submitter- or reporter-controlled. */}
          <h2 className="font-medium break-words">{item.customTitle}</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {STATUS_LABELS[item.status] ?? item.status} · {item.upvoteCount} upvotes · suggested by{' '}
            {item.submittedBy.fullName ?? 'a patron'}
          </p>
          {item.description ? (
            <p className="mt-2 whitespace-pre-line break-words text-sm text-slate-600 dark:text-slate-300">
              {item.description}
            </p>
          ) : null}
          {/* Without this a moderator reviewing a fifty-step watch order sees a title and
              nothing else — which is what the API change exists to prevent. */}
          <WatchOrderList items={item.watchOrderItems ?? []} />
          <NoteList notes={item.notes ?? []} />
          <NoteEditor
            slug={slug}
            recommendationId={item.id}
            onWritten={(note) => onUpdate(item.id, { notes: [...(item.notes ?? []), note] })}
          />
        </div>
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => setRedacting((value) => !value)}
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Redact
          </button>
          <StatusControl
            slug={slug}
            recommendationId={item.id}
            title={item.customTitle}
            status={item.status}
            onChanged={(id, status) => onUpdate(id, { status })}
          />
        </div>
      </div>

      {redacting ? (
        <RedactForm
          slug={slug}
          item={item}
          onDone={(changes) => {
            onUpdate(item.id, changes);
            setRedacting(false);
          }}
        />
      ) : null}

      <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Reports ({item.openFlagCount})
        </h3>
        {item.flags.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">No open reports.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {item.flags.map((flag) => (
              <li key={flag.id} className="text-xs">
                <p className="font-medium">
                  {REASON_LABELS[flag.reason] ?? flag.reason}
                  <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                    reported by {flag.flaggedBy.fullName ?? 'a patron'}
                  </span>
                </p>
                {flag.note ? (
                  <p className="mt-0.5 break-words text-slate-600 dark:text-slate-300">
                    {flag.note}
                  </p>
                ) : null}
                <FlagActions
                  slug={slug}
                  flagId={flag.id}
                  onResolved={() => onFlagResolved(item.id, flag.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function FlagActions({
  slug,
  flagId,
  onResolved,
}: {
  slug: string;
  flagId: string;
  onResolved: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(status: 'RESOLVED' | 'DISMISSED') {
    setBusy(true);
    setMessage(null);
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/flags/${flagId}`, { status });
      onResolved();
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 403
          ? 'You do not moderate this board.'
          : 'Could not update that report. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="mt-1 flex gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => resolve('RESOLVED')}
        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Uphold
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => resolve('DISMISSED')}
        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Dismiss
      </button>
      {message ? (
        <span role="status" className="text-red-600 dark:text-red-400">
          {message}
        </span>
      ) : null}
    </p>
  );
}

function RedactForm({
  slug,
  item,
  onDone,
}: {
  slug: string;
  item: ReviewQueueItem;
  onDone: (changes: Partial<ReviewQueueItem>) => void;
}) {
  const [customTitle, setCustomTitle] = useState(item.customTitle);
  const [description, setDescription] = useState(item.description ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    // Only what actually changed: the API rejects an empty PATCH rather than writing an audit
    // row for an edit that did not happen, and sending unchanged fields would fake one.
    const changes: Record<string, string> = {};
    if (customTitle !== item.customTitle) changes.customTitle = customTitle;
    if (description !== (item.description ?? '')) changes.description = description;
    if (Object.keys(changes).length === 0) {
      setMessage('Nothing changed.');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.patch<{ customTitle: string; description: string | null }>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${item.id}`,
        changes,
      );
      onDone({ customTitle: updated.customTitle, description: updated.description });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      setMessage(
        status === 400
          ? 'That text was rejected. Try rewording it.'
          : status === 403
            ? 'You do not moderate this board.'
            : 'Could not save that redaction. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800">
      <div>
        <label htmlFor={`title-${item.id}`} className="block text-xs font-medium">
          Title
        </label>
        <input
          id={`title-${item.id}`}
          value={customTitle}
          maxLength={200}
          onChange={(event) => setCustomTitle(event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </div>
      <div>
        <label htmlFor={`desc-${item.id}`} className="block text-xs font-medium">
          Description
        </label>
        <textarea
          id={`desc-${item.id}`}
          value={description}
          maxLength={2000}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
      >
        {busy ? 'Saving…' : 'Save redaction'}
      </button>
      {message ? (
        <p role="status" aria-live="polite" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
