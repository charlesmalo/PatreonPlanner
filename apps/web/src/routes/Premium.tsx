import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Subscription {
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

/** In the reader's terms. The enum is ours; what it means to them is not the same sentence. */
const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  PAST_DUE: 'We could not take the last payment — your card may need updating',
  CANCELLED: 'Ending — you keep everything until the date below',
  EXPIRED: 'Ended',
  REFUNDED: 'Refunded',
};

/**
 * Where somebody buys premium, and sees what they already have.
 *
 * Checkout is a hosted page on the provider's domain: no card number, no billing address, and no
 * payment field ever reaches this application. What comes back is a webhook, not the reader —
 * returning from checkout shows them a page and grants nothing, because a URL is something anyone
 * can type.
 */
export function Premium() {
  const [available, setAvailable] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ available: boolean; subscription: Subscription | null }>('/billing/subscription')
      .then((state) => {
        if (cancelled) return;
        setAvailable(state.available);
        setSubscription(state.subscription);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function subscribe() {
    setBusy(true);
    try {
      const { url } = await api.post<{ url: string }>('/billing/checkout', {});
      window.location.href = url;
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  if (failed) return <p className="p-4">Could not load your subscription.</p>;
  // Gated rather than rendering the shell: saying "you are not subscribed" while the answer is
  // still in flight is a different claim from "still looking", and the wrong one.
  if (loading) return <p className="p-4">Loading…</p>;

  return (
    <section className="mx-auto max-w-lg p-4">
      <h1 className="text-lg font-medium">Premium</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Everything the boards do stays free. Premium adds more of the reaction palette, settings
        that follow you between devices, and carrying a list to every board you support.
      </p>

      {subscription ? (
        <div className="mt-4 rounded border border-slate-300 p-3 text-sm dark:border-slate-700">
          <p>{STATUS_LABELS[subscription.status] ?? subscription.status}</p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            {subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on{' '}
            {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
          </p>
          <p className="mt-2 text-slate-500 dark:text-slate-400">
            Payments, invoices and cancelling are handled by our payment provider — the receipt they
            emailed you links to it.
          </p>
        </div>
      ) : available ? (
        <button
          type="button"
          onClick={subscribe}
          disabled={busy}
          className="mt-4 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? 'Taking you there…' : 'Subscribe'}
        </button>
      ) : (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          Subscriptions are not available on this instance.
        </p>
      )}
    </section>
  );
}
