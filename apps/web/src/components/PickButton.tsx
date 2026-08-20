import { useState } from 'react';
import { api } from '../api/client';

interface PickButtonProps {
  slug: string;
  recommendationId: string;
  title: string;
  isPick: boolean;
}

/**
 * The creator's own shortlist. A picked entry leads its column whatever the sort, so this is a
 * curation control rather than a filter — the reader never has to ask for it.
 */
export function PickButton({ slug, recommendationId, title, isPick }: PickButtonProps) {
  const [picked, setPicked] = useState(isPick);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !picked;
    // Optimistic, then reconciled: a control that goes on claiming a change the server refused is
    // worse than one that flickers.
    setPicked(next);
    setBusy(true);
    try {
      const path = `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/pick`;
      if (next) await api.post(path);
      else await api.del(path);
    } catch {
      setPicked(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={picked}
      aria-label={`${picked ? 'Unpick' : 'Pick'} “${title}”`}
      className="rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
    >
      {picked ? '★ Picked' : '☆ Pick'}
    </button>
  );
}
