import { useState } from 'react';
import { ApiError, api } from '../api/client';

interface RedeemButtonProps {
  slug: string;
  recommendationId: string;
  title: string;
  /** This reader's balance on this board. Zero renders nothing at all. */
  available: number;
  onRedeemed: () => void;
}

/**
 * Spending one token on an accepted entry.
 *
 * The note is the point of the control, not a decoration on it: nothing in this system models an
 * episode, so what the creator plays is whatever the patron writes here. That is why an empty one
 * is refused before the request is made.
 *
 * Absent at a balance of zero rather than present and refusing — a control that always fails is
 * worse than no control, and the API's 409 would read as a broken page.
 */
export function RedeemButton({
  slug,
  recommendationId,
  title,
  available,
  onRedeemed,
}: RedeemButtonProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (available <= 0) return null;

  async function spend() {
    const trimmed = note.trim();
    // Answered here rather than sent: the server refuses an empty note too, but its error reads
    // like the page is broken when nothing on screen said the note was required.
    if (trimmed.length === 0) {
      setMessage('Say what should be played — the creator reads this.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.post(
        `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/redeem`,
        { note: trimmed },
      );
      setOpen(false);
      setNote('');
      onRedeemed();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      setMessage(
        status === 409
          ? // 409 is the status where trying again cannot work: the balance is gone, or somebody
            // moved the entry out of Accepted while this was open.
            'Could not spend that — reload to see where this entry is now.'
          : 'Could not spend that token. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        // Names the entry, so a screen reader on a long board knows which card this belongs to.
        aria-label={`Redeem a token on “${title}”`}
        className="rounded border border-sky-500 px-2 py-1 text-xs text-sky-700 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300 dark:hover:bg-sky-950"
      >
        Redeem · {available}
      </button>
      {open ? (
        <div className="mt-1 rounded border border-slate-300 p-2 dark:border-slate-700">
          <label htmlFor={`note-${recommendationId}`} className="block text-xs font-medium">
            What should be played?
          </label>
          <input
            id={`note-${recommendationId}`}
            value={note}
            maxLength={200}
            placeholder="S2E04, or the one about the dog"
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="button"
            disabled={busy}
            onClick={spend}
            className="mt-2 rounded bg-sky-600 px-3 py-1 text-xs text-white disabled:opacity-50 hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Spend
          </button>
        </div>
      ) : null}
      {message ? (
        <p role="status" aria-live="polite" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
