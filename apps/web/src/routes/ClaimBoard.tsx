import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

interface Claimable {
  patreonCampaignId: string;
  displayName: string;
  claimed: boolean;
  slug: string | null;
}

type Load = { state: 'loading' } | { state: 'ready'; items: Claimable[] } | { state: 'failed' };

/**
 * Creating a board from a campaign this account owns.
 *
 * `POST /creators/claim` has existed since the beginning and nothing in the app called it, so
 * every board in this project was made by SQL or by a test. In production the product had no
 * front door for creators at all.
 *
 * Ownership is not asserted here and cannot be: the API checks the chosen campaign against what
 * Patreon says this token's owner controls, and absence is the proof. This page only offers the
 * choice.
 */
export function ClaimBoard() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [claiming, setClaiming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ items: Claimable[] }>('/creators/claimable')
      .then((body) => {
        if (!cancelled) setLoad({ state: 'ready', items: body?.items ?? [] });
      })
      .catch(() => {
        // Never rendered as an empty list. "You own no campaigns" and "Patreon could not be
        // reached" are different statements, and answering the first when the second is true
        // sends a creator away believing they have nothing to claim.
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function claim(campaign: Claimable) {
    // Held while the request is in flight: two presses are two claims, and the second answers 409
    // — which reads like a failure on a board that was in fact created.
    setClaiming(campaign.patreonCampaignId);
    setMessage(null);
    try {
      const created = await api.post<{ slug: string }>('/creators/claim', {
        patreonCampaignId: campaign.patreonCampaignId,
      });
      navigate(`/c/${created.slug}`);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      setMessage(
        status === 409
          ? 'That campaign is already a board.'
          : status === 403
            ? 'Patreon does not list that campaign as yours.'
            : 'That did not work. Nothing was created.',
      );
      setClaiming(null);
    }
  }

  if (load.state === 'loading') return <p className="p-4">Loading…</p>;
  if (load.state === 'failed')
    return (
      <section className="max-w-prose">
        <h1 className="text-lg font-medium">Create a board</h1>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          Could not reach Patreon, so which campaigns you own is unknown. This is not the same as
          owning none — try again shortly.
        </p>
      </section>
    );

  return (
    <section className="max-w-prose">
      <h1 className="text-lg font-medium">Create a board</h1>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        One board per campaign. Everything on it — who may read it, who may suggest, who may upvote
        — is yours to change afterwards.
      </p>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        {/* Said before the board exists rather than discovered later. The default is not a
            detail: a board anyone can read is a list of what a creator is watching, and those
            lists get scraped to file fraudulent copyright claims. */}
        A new board starts visible to <span className="font-medium">only your supporters</span>,
        because a board the whole internet can read is a list of what you are watching.
      </p>

      {load.items.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          Patreon lists no campaigns for this account. A board is made from a campaign you run, so
          there is nothing to create one from yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {load.items.map((campaign) => (
            <li
              key={campaign.patreonCampaignId}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              {/* An already-claimed campaign is a link, not a disabled button. Pressing claim on
                  it answers 409; sending them to the board they already made is the answer they
                  actually wanted. */}
              {campaign.claimed && campaign.slug ? (
                <>
                  <Link
                    to={`/c/${campaign.slug}`}
                    className="font-medium underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  >
                    {campaign.displayName}
                  </Link>
                  <span className="text-slate-600 dark:text-slate-300">already a board</span>
                </>
              ) : (
                <>
                  <span className="font-medium">{campaign.displayName}</span>
                  <button
                    type="button"
                    disabled={claiming !== null}
                    onClick={() => claim(campaign)}
                    aria-label={`Create the board for ${campaign.displayName}`}
                    className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    {claiming === campaign.patreonCampaignId ? 'Creating…' : 'Create board'}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {message ? (
        <p role="status" className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      ) : null}
    </section>
  );
}
