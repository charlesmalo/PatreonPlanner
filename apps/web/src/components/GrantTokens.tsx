import { useState } from 'react';
import { api } from '../api/client';

interface GrantTokensProps {
  slug: string;
  /** Who the creator can hand tokens to: their staff, and anyone who has redeemed before. */
  people: Array<{ userId: string; name: string }>;
}

/**
 * The creator giving somebody tokens directly.
 *
 * The case this exists for is thanking a moderator: the recipient need not be a patron, need not
 * hold a tier, and need not have spent anything. A tier grant says "you pay for this"; this says
 * "thank you", and the ledger records which it was.
 *
 * Owner-only, matching the API — minting something that obliges the creator to play an entry is
 * not a moderation power.
 */
export function GrantTokens({ slug, people }: GrantTokensProps) {
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState(1);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Nobody to grant to yet. A form whose only field is an empty list is a control that cannot be
  // used, and it would read as broken rather than as not-yet-applicable.
  if (people.length === 0) return null;

  async function grant() {
    if (!userId) {
      setMessage('Choose who the tokens are for.');
      return;
    }
    if (reason.trim().length === 0) {
      setMessage('Say what they are for — the ledger keeps this.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.post(`/creators/${encodeURIComponent(slug)}/tokens/grants`, {
        userId,
        amount,
        reason: reason.trim(),
      });
      setMessage('Granted.');
      setReason('');
    } catch {
      setMessage('That did not send. Nothing was granted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6">
      <h2 className="text-sm font-medium">Give someone tokens</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        A thank-you rather than a tier grant — a moderator who pays nothing can be given these, and
        the ledger records that you gave them rather than that a tier did.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
        <span className="flex flex-col">
          <label htmlFor="grant-who" className="text-xs font-medium">
            Who
          </label>
          <select
            id="grant-who"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            className="mt-1 rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Choose…</option>
            {people.map((person) => (
              /* Text, never markup: a display name comes from Patreon. */
              <option key={person.userId} value={person.userId}>
                {person.name}
              </option>
            ))}
          </select>
        </span>

        <span className="flex flex-col">
          <label htmlFor="grant-amount" className="text-xs font-medium">
            How many
          </label>
          <input
            id="grant-amount"
            type="number"
            min={1}
            max={50}
            value={amount}
            onChange={(event) => setAmount(Number(event.target.value))}
            className="mt-1 w-20 rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </span>

        <span className="flex flex-1 flex-col">
          <label htmlFor="grant-reason" className="text-xs font-medium">
            What for
          </label>
          <input
            id="grant-reason"
            value={reason}
            maxLength={200}
            placeholder="for working the queue all month"
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </span>

        <button
          type="button"
          disabled={busy}
          onClick={grant}
          className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
        >
          Give
        </button>
      </div>

      {message ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
