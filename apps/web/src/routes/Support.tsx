import { useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Where donations go. Set at build time, and deliberately absent by default: a donate button
 * that leads nowhere is worse than no button.
 *
 * A link out to a payment host, never a payment taken here. That keeps every credential outside
 * this system and avoids webhook confirmation, refunds, chargebacks and PCI scope — for a feature
 * whose purpose is covering a domain fee.
 */
const DONATION_URL = import.meta.env.VITE_DONATION_URL;

const PRESETS = [2, 5, 10];
const DEFAULT_AMOUNT = 5;
const MAX_AMOUNT = 1000;

export function Support() {
  const [amount, setAmount] = useState<number>(DEFAULT_AMOUNT);
  const [custom, setCustom] = useState('');
  const [usingCustom, setUsingCustom] = useState(false);

  const parsed = Number(custom);
  const customValid = usingCustom && Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_AMOUNT;
  const chosen = usingCustom ? (customValid ? parsed : null) : amount;

  return (
    <section className="max-w-prose">
      <h1 className="text-2xl font-semibold tracking-tight">Support the developers</h1>
      <p className="mt-3 text-slate-600 dark:text-slate-300">
        PatreonPlanner is free, and the parts that cost money — a domain, a server — come out of
        someone&apos;s pocket. If it is useful to you, a coffee helps keep it running.
      </p>

      {DONATION_URL ? (
        <>
          <fieldset className="mt-6">
            <legend className="text-sm font-medium">How much?</legend>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {PRESETS.map((value) => (
                <label key={value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="amount"
                    checked={!usingCustom && amount === value}
                    onChange={() => {
                      setUsingCustom(false);
                      setAmount(value);
                    }}
                  />
                  ${value}
                </label>
              ))}
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="amount"
                  checked={usingCustom}
                  onChange={() => setUsingCustom(true)}
                />
                Another amount
              </label>
              {usingCustom ? (
                <>
                  <label htmlFor="custom-amount" className="sr-only">
                    Amount in dollars
                  </label>
                  <input
                    id="custom-amount"
                    type="number"
                    min="1"
                    max={MAX_AMOUNT}
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    className="w-24 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
                  />
                </>
              ) : null}
            </div>
            {usingCustom && custom !== '' && !customValid ? (
              <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                Enter an amount between $1 and ${MAX_AMOUNT}.
              </p>
            ) : null}
          </fieldset>

          {/* An anchor, not a fetch: this leaves for the payment host, and nothing about the
              transaction comes back through this app. */}
          <a
            href={chosen ? `${DONATION_URL}/${chosen}` : DONATION_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={chosen === null}
            onClick={(event) => {
              if (chosen === null) event.preventDefault();
            }}
            className={`mt-5 inline-block rounded px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              chosen === null
                ? 'pointer-events-none bg-slate-400 opacity-60'
                : 'bg-slate-900 hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300'
            }`}
          >
            {chosen === null ? 'Choose an amount' : `Buy a coffee — $${chosen}`}
          </a>
        </>
      ) : (
        <p className="mt-6 rounded border border-slate-200 px-3 py-2 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
          Donations are not set up on this deployment yet.
        </p>
      )}

      {/* The disclaimer uBlock and similar carry. A gift, not a purchase, and the giver's own
          rules are theirs to follow. */}
      <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">
        Donations are a voluntary gift supporting development, not a purchase, and buy no feature or
        service. They are most likely not tax-deductible. Following your own country&apos;s rules
        about giving is your responsibility.
      </p>

      <p className="mt-6">
        <Link
          to="/"
          className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Back to PatreonPlanner
        </Link>
      </p>
    </section>
  );
}
