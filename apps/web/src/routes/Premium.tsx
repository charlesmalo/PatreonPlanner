import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Receipt {
  id: string;
  providerReceiptId: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  /** Provider-hosted. Null for a provider that hosts none — the fake one never does. */
  url: string | null;
}

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
  const [sandbox, setSandbox] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ available: boolean; sandbox: boolean; subscription: Subscription | null }>(
        '/billing/subscription',
      )
      .then((state) => {
        if (cancelled) return;
        setAvailable(state.available);
        setSandbox(state.sandbox);
        setSubscription(state.subscription);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // A separate read, and deliberately not part of the one above: payment history is the least
    // important thing on this page, and a failure to load it must not take the renewal date with
    // it. It fails silently to an empty list.
    api
      .get<{ receipts: Receipt[] }>('/billing/receipts')
      .then((body) => {
        if (!cancelled) setReceipts(body.receipts);
      })
      .catch(() => {
        /* No history shown. The subscription above is what this page is actually for. */
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
      {sandbox && (
        <div className="mt-6 rounded border-2 border-dashed border-amber-600 p-3 text-sm">
          <h2 className="font-medium">Demo payment controls</h2>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            This instance is not connected to a payment provider. Nothing here charges anybody, and
            no card is ever asked for. Use these to walk through what a subscription does — paying,
            a failed renewal, cancelling, a refund.
          </p>
          <button
            type="button"
            onClick={subscribe}
            disabled={busy}
            className="mt-2 rounded border border-slate-400 px-3 py-1.5 font-medium disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
          >
            Open the demo checkout
          </button>
        </div>
      )}

      {receipts.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-medium">Payments</h2>
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Your payments</caption>
            <thead>
              <tr className="text-left text-slate-600 dark:text-slate-300">
                <th scope="col" className="font-normal">
                  Date
                </th>
                <th scope="col" className="font-normal">
                  Amount
                </th>
                <th scope="col" className="font-normal">
                  <span className="sr-only">Receipt</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((receipt) => (
                <tr key={receipt.id} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="py-1">{new Date(receipt.paidAt).toLocaleDateString()}</td>
                  <td className="py-1">{formatAmount(receipt.amountCents, receipt.currency)}</td>
                  <td className="py-1 text-right">
                    {receipt.url ? (
                      <a
                        href={receipt.url}
                        // Opening someone's billing record in a new tab, without handing the
                        // provider a referrer or a window handle back into this one.
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                      >
                        Receipt
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Minor units to the reader's locale. Intl rather than dividing by a hundred and appending a
 * symbol: not every currency has two decimal places, and the ones that do not would be shown
 * off by a factor of a hundred.
 */
function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      amountCents / 100,
    );
  } catch {
    // An unknown currency code throws rather than falling back, and a payments table is not
    // worth a blank page.
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}
