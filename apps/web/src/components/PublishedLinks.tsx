import { useState } from 'react';
import { api } from '../api/client';
import type { RecommendationLink, StaffPermission } from '../api/types';
import { isSafeHttpUrl } from './safe-url';

interface PublishedLinksProps {
  slug: string;
  links: RecommendationLink[];
  canModerate: boolean;
  /** A rendering hint. `PATCH` checks MODERATE and EDIT_ENTRIES again and refuses regardless. */
  permissions: StaffPermission[];
}

/**
 * Where to go for this entry, in the order the creator chose.
 *
 * `isPreferred` was the whole of a feature nobody could reach. The API has a DTO field for it, a
 * single-preferred invariant kept inside a transaction, a rule that preferring a candidate
 * publishes it — "a hidden favourite is no favourite" — and a read path that orders by it. The
 * client named the field in `api/types.ts` and never sent it, so it was `false` on every row in
 * every running system and the ordering it drives never differed from insertion order.
 *
 * The reader-facing effect stays exactly what the server already implements: the preferred link
 * sorts first. The marker and the control are drawn only for staff who may act, because to anyone
 * else "shown first" describes a decision they cannot make and cannot see the alternative to.
 */
export function PublishedLinks({ slug, links, canModerate, permissions }: PublishedLinksProps) {
  // Seeded and then owned, like the candidate list next door: preferring is the creator's own
  // change and is applied here rather than by refetching the board behind them.
  const [rows, setRows] = useState(links);
  const [busy, setBusy] = useState<string | null>(null);

  const visible = rows.filter((link) => isSafeHttpUrl(link.url));
  if (visible.length === 0) return null;

  const mayDecide = canModerate && (permissions ?? []).includes('EDIT_ENTRIES');

  async function prefer(link: RecommendationLink) {
    const previous = rows;
    setBusy(link.id);
    setRows((current) => current.map((row) => ({ ...row, isPreferred: row.id === link.id })));
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/links/${link.id}`, {
        isPreferred: true,
      });
    } catch {
      // Back to exactly what the server still holds. A marker that stays put after a refusal
      // tells the creator they made a choice the board has not got.
      setRows(previous);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="mt-2 flex flex-wrap items-center gap-3">
      {visible.map((link) => (
        <li key={link.id} className="flex items-center gap-1.5">
          <a
            href={link.url}
            target="_blank"
            // The URL is entirely submitter-chosen, so the opened page must not get a handle on
            // this one.
            rel="noopener noreferrer"
            className="break-all text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            {link.label ?? link.url}
          </a>
          {mayDecide && link.isPreferred ? (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              Shown first
            </span>
          ) : null}
          {mayDecide && !link.isPreferred ? (
            <button
              type="button"
              onClick={() => prefer(link)}
              disabled={busy === link.id}
              aria-label={`Prefer ${link.url}`}
              className="rounded border border-slate-300 px-1.5 py-0.5 text-xs disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Show first
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
