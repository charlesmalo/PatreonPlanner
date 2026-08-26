import { useState } from 'react';
import { api } from '../api/client';
import type { RecommendationLink, StaffPermission } from '../api/types';
import { isSafeHttpUrl } from './safe-url';

interface LinkCandidatesProps {
  slug: string;
  candidates: RecommendationLink[];
  /** Any staff member is sent candidates; only some may act on them. */
  canModerate: boolean;
  /** A rendering hint. `PATCH`/`DELETE` check EDIT_ENTRIES again and refuse regardless. */
  permissions: StaffPermission[];
}

/**
 * Links somebody suggested, waiting for a human.
 *
 * A patron's link is a claim, not an endorsement, so it is held back until staff publish it.
 * That mechanism is only half a feature without somewhere to act on it: without this, a
 * candidate is released by a direct API call or not at all, and in practice every suggested
 * link is discarded by inaction.
 *
 * The API decides *who* is sent candidates — staff, and a candidate's own submitter. This
 * component only decides what to draw, and every control here is refused server-side too.
 */
export function LinkCandidates({
  slug,
  candidates,
  canModerate,
  permissions,
}: LinkCandidatesProps) {
  // Seeded from the prop and owned from then on: publishing and discarding are the creator's own
  // changes, applied locally rather than by refetching the board behind them.
  const [pending, setPending] = useState(candidates);
  const [published, setPublished] = useState<RecommendationLink[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  if (pending.length === 0 && published.length === 0) return null;

  const mayDecide = (permissions ?? []).includes('EDIT_ENTRIES');
  // A non-staff viewer is only ever sent their own candidate, so this is always true for them.
  const heading = canModerate
    ? 'Suggested links, waiting for review'
    : 'Your link is waiting for review';

  const path = (id: string) => `/creators/${encodeURIComponent(slug)}/links/${id}`;

  async function publish(link: RecommendationLink) {
    setBusy(link.id);
    // Optimistic, then reconciled — the pattern the pick control already follows. A row that
    // goes on claiming a change the server refused is worse than one that flickers.
    setPending((rows) => rows.filter((r) => r.id !== link.id));
    setPublished((rows) => [...rows, link]);
    try {
      await api.patch(path(link.id), { status: 'PUBLISHED' });
    } catch {
      setPublished((rows) => rows.filter((r) => r.id !== link.id));
      setPending((rows) => [...rows, link]);
    } finally {
      setBusy(null);
    }
  }

  async function discard(link: RecommendationLink) {
    setBusy(link.id);
    setPending((rows) => rows.filter((r) => r.id !== link.id));
    try {
      await api.del(path(link.id));
    } catch {
      // Put back rather than left gone: a creator who thinks they handled a candidate the server
      // still holds will meet it again on the next load with no explanation.
      setPending((rows) => [...rows, link]);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-2 rounded border border-dashed border-slate-300 p-2 dark:border-slate-600">
      <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400">{heading}</h4>
      <ul className="mt-1 space-y-1">
        {pending.map((link) => (
          <li key={link.id} className="flex flex-wrap items-center gap-2">
            {/* Text, never an anchor. An unreviewed URL does not get the creator's reach, and
                that is the whole reason it is waiting here. */}
            <span className="break-all text-sm text-slate-600 dark:text-slate-300">
              {link.label ? `${link.label} — ${link.url}` : link.url}
            </span>
            {mayDecide ? (
              <>
                <button
                  type="button"
                  onClick={() => publish(link)}
                  disabled={busy === link.id}
                  aria-label={`Publish ${link.url}`}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Publish
                </button>
                <button
                  type="button"
                  onClick={() => discard(link)}
                  disabled={busy === link.id}
                  aria-label={`Discard ${link.url}`}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Discard
                </button>
              </>
            ) : null}
          </li>
        ))}
        {/* Shown here rather than waiting for the board to reload, so publishing visibly does
            something. The next load renders them from the card's own list instead. */}
        {published
          .filter((link) => isSafeHttpUrl(link.url))
          .map((link) => (
            <li key={link.id}>
              <a
                href={link.url}
                target="_blank"
                // The URL is entirely submitter-chosen, so the opened page must not get a handle
                // on this one.
                rel="noopener noreferrer"
                className="break-all text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
              >
                {link.label ?? link.url}
              </a>
            </li>
          ))}
      </ul>
    </section>
  );
}
