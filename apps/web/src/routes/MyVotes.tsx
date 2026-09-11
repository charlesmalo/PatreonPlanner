import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';

interface MyVote {
  recommendationId: string;
  title: string;
  status: string;
  worth: number;
}

interface MyVotesResponse {
  items: MyVote[];
  currentWorth: number;
  couldImprove: number;
}

/**
 * What a patron's votes are worth, and the one thing they can do about it.
 *
 * Per board: a vote is worth what *this* creator's tiers say it is, so a list mixing boards would
 * be a column of numbers that mean different things.
 */
export function MyVotes() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<MyVotesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<MyVotesResponse>(`/creators/${encodeURIComponent(slug)}/my-votes`));
    } catch {
      setData({ items: [], currentWorth: 1, couldImprove: 0 });
      setMessage('Could not load your votes.');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ updated: number }>(
        `/creators/${encodeURIComponent(slug)}/my-votes/refresh`,
      );
      setMessage(
        result.updated === 0
          ? 'Nothing to update.'
          : `Updated ${result.updated} ${result.updated === 1 ? 'vote' : 'votes'}.`,
      );
      await load();
    } catch {
      // A board can switch this off, and a reader should be told that rather than left guessing.
      setMessage('This board does not update votes to a new tier.');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <p role="status">Loading…</p>;
  }

  return (
    <section>
      <p>
        <Link
          to={`/c/${slug}`}
          className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Back to the board
        </Link>
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Your votes</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">
        A vote counts for what your tier was worth when you cast it. Yours is currently worth{' '}
        {data.currentWorth}.
      </p>

      {data.couldImprove > 0 ? (
        <div className="mt-4 rounded border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950/40">
          <p className="text-sm">
            {/* "1 of your votes were cast" is the sentence a count-plus-fixed-verb always
                produces eventually, and one is the commonest case here — a patron upgrades and
                has a single stale vote. */}
            {data.couldImprove === 1
              ? 'One of your votes was cast at a lower tier than you hold now.'
              : `${data.couldImprove} of your votes were cast at a lower tier than you hold now.`}
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {busy ? 'Updating…' : 'Bring them up to date'}
          </button>
        </div>
      ) : null}

      <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        {message}
      </p>

      {data.items.length === 0 ? (
        <p className="mt-6 text-slate-600 dark:text-slate-300">You have not voted here yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200 dark:divide-slate-800">
          {data.items.map((vote) => (
            <li
              key={vote.recommendationId}
              className="flex items-baseline justify-between gap-3 py-2"
            >
              <Link
                to={`/c/${slug}/e/${vote.recommendationId}`}
                className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                {vote.title}
              </Link>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                worth {vote.worth}
                {/* Named rather than left as a bare smaller number, so it is obvious why the
                    button above exists. */}
                {vote.worth < data.currentWorth ? ' — below your tier' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
