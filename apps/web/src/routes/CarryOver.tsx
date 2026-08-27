import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Source {
  id: string;
  customTitle: string | null;
  type: string;
  creator: { slug: string; displayName: string };
}

interface Target {
  slug: string;
  displayName: string;
}

interface Delivery {
  id: string;
  outcome: string;
  resultRecommendationId: string | null;
  createdAt: string;
  creator: { slug: string; displayName: string };
  source: { id: string; customTitle: string | null } | null;
}

/** What each outcome means, in the reader's terms rather than the enum's. */
const OUTCOME_LABELS: Record<string, string> = {
  PENDING: 'Waiting its turn',
  SUBMITTED: 'Suggested',
  ALREADY_PRESENT: 'Already on that board',
  REFUSED_BEFORE: 'That board turned this down before',
  NOT_ELIGIBLE: 'You cannot suggest there at the moment',
  NOT_ACCEPTED: 'That board does not take carried-over lists',
  FAILED: 'Could not be sent',
};

/**
 * Putting the same handful of titles in front of every board you support.
 *
 * Deliveries drain at each board's own rate, so a long list fills in over hours rather than at
 * once — the page says so, because a progress list that stalls with no explanation reads as
 * broken rather than as working correctly.
 */
export function CarryOver() {
  const [sources, setSources] = useState<Source[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [chosenSources, setChosenSources] = useState<string[]>([]);
  const [chosenTargets, setChosenTargets] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ sources: Source[]; targets: Target[] }>('/carry-over/options'),
      api.get<Delivery[]>('/carry-over'),
    ])
      .then(([options, sent]) => {
        if (cancelled) return;
        setSources(options.sources);
        setTargets(options.targets);
        setDeliveries(sent);
      })
      .catch(() => {
        if (!cancelled) setFailed('Could not load your suggestions.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const { queued } = await api.post<{ queued: number }>('/carry-over', {
        sourceIds: chosenSources,
        creatorSlugs: chosenTargets,
      });
      // Says it is queued rather than done: they drain at each board's own rate, and claiming
      // otherwise would have people refreshing a list that is working exactly as intended.
      setMessage(
        queued === 0
          ? 'Nothing new to send — those are already on their way.'
          : `${queued} on the way. They arrive at each board's own pace, so this can take a while.`,
      );
      setDeliveries(await api.get<Delivery[]>('/carry-over'));
    } catch {
      setMessage('Could not send those. Nothing was queued.');
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <p className="p-4">{failed}</p>;
  // Gated rather than rendering the shell around an empty list: without this the page says "you
  // have not suggested anything yet" while the answer is still in flight, which is a different
  // claim from "still looking" and the wrong one.
  if (loading) return <p className="p-4">Loading…</p>;

  return (
    <section className="mx-auto max-w-2xl p-4">
      <h1 className="text-lg font-medium">Suggest the same things elsewhere</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Pick from what you have already suggested, and the boards to send it to. Each creator still
        reviews it like any other suggestion.
      </p>

      <h2 className="mt-4 text-sm font-medium">What to send</h2>
      <ul className="mt-1 space-y-1">
        {sources.map((source) => (
          <li key={source.id}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosenSources.includes(source.id)}
                onChange={() => setChosenSources((c) => toggle(c, source.id))}
              />
              <span>
                {source.customTitle ?? 'Untitled'}{' '}
                <span className="text-slate-500 dark:text-slate-400">
                  from {source.creator.displayName}
                </span>
              </span>
            </label>
          </li>
        ))}
        {sources.length === 0 ? (
          <li className="text-sm text-slate-500 dark:text-slate-400">
            You have not suggested anything yet.
          </li>
        ) : null}
      </ul>

      <h2 className="mt-4 text-sm font-medium">Where to send it</h2>
      <ul className="mt-1 space-y-1">
        {targets.map((target) => (
          <li key={target.slug}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosenTargets.includes(target.slug)}
                onChange={() => setChosenTargets((c) => toggle(c, target.slug))}
              />
              <span>{target.displayName}</span>
            </label>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={send}
        disabled={busy || chosenSources.length === 0 || chosenTargets.length === 0}
        className="mt-4 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-100 dark:text-slate-900"
      >
        {busy ? 'Sending…' : 'Send these'}
      </button>
      {message ? <p className="mt-2 text-sm">{message}</p> : null}

      {deliveries.length > 0 ? (
        <>
          <h2 className="mt-6 text-sm font-medium">What happened</h2>
          <ul className="mt-1 space-y-1">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="text-sm">
                <span>{delivery.source?.customTitle ?? 'A suggestion'}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  {' → '}
                  {delivery.creator.displayName}:{' '}
                  {OUTCOME_LABELS[delivery.outcome] ?? delivery.outcome}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
