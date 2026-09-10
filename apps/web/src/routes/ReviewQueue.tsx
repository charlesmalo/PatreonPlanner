import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useCreator, useReviewQueue } from '../api/hooks';
import type { ReviewQueueItem } from '../api/types';
import { STATUS_LABELS, StatusControl } from '../components/StatusControl';
import { NoteEditor } from '../components/NoteEditor';
import { NoteList } from '../components/NoteList';
import { WatchOrderList } from '../components/WatchOrderList';
import { FlagActions } from './FlagActions';
import type { StaffPermission } from '../api/types';
import { RedactForm } from './RedactForm';

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
  const { creator, capabilities } = useCreator(slug);
  const queue = useReviewQueue(slug);

  if (queue.loading) {
    return <p role="status">Loading the review queue…</p>;
  }

  if (queue.error) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-300">
        {/*
          Which 403 this is decides the sentence, and the client already knows: the same
          capabilities payload that gates the link says whether this reader moderates the board at
          all. Somebody removed from staff genuinely does not moderate it; somebody who moderates
          it and lacks HANDLE_REPORTS does, and telling them otherwise sends them looking for a
          staff row they already have. One message for both cases is wrong for one of them.
        */}
        {queue.error.status === 403 || queue.error.status === 401
          ? capabilities.moderate
            ? 'Handling reports is not one of your permissions on this board.'
            : 'You do not moderate this board.'
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
              permissions={capabilities.permissions ?? []}
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
  /**
   * What this moderator may actually do here.
   *
   * Loading the queue takes HANDLE_REPORTS and nothing more, so a moderator can reach this page
   * and hold none of the permissions the controls on it require — which is precisely what an owner
   * narrowing a moderator produces. Each control below is offered on the same terms the endpoint
   * behind it demands.
   */
  permissions: StaffPermission[];
  slug: string;
  item: ReviewQueueItem;
  onUpdate: (id: string, changes: Partial<ReviewQueueItem>) => void;
  onFlagResolved: (recommendationId: string, flagId: string) => void;
}

function QueueRow({ slug, item, permissions, onUpdate, onFlagResolved }: QueueRowProps) {
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
          <NoteList
            notes={item.notes ?? []}
            // A TIMELINE note is public the moment it is written and there is no draft state, so
            // deleting is the only way back from a mis-picked kind. Without this the product had
            // no path to it at all.
            onDelete={async (note) => {
              try {
                await api.del(`/creators/${encodeURIComponent(slug)}/notes/${note.id}`);
                onUpdate(item.id, {
                  notes: (item.notes ?? []).filter((n) => n.id !== note.id),
                });
              } catch {
                // Left in place: the server still has it, and pretending otherwise is worse.
              }
            }}
          />
          {permissions.includes('WRITE_NOTES') ? (
            <NoteEditor
              slug={slug}
              recommendationId={item.id}
              onWritten={(note) => onUpdate(item.id, { notes: [...(item.notes ?? []), note] })}
            />
          ) : null}
        </div>
        <div className="flex items-start gap-2">
          {permissions.includes('EDIT_ENTRIES') ? (
            <button
              type="button"
              onClick={() => setRedacting((value) => !value)}
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Redact
            </button>
          ) : null}
          {permissions.includes('MOVE_ENTRIES') ? (
            <StatusControl
              slug={slug}
              recommendationId={item.id}
              title={item.customTitle}
              status={item.status}
              onChanged={(id, status) => onUpdate(id, { status })}
            />
          ) : null}
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
