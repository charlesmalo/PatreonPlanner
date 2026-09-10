import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useCreator } from '../api/hooks';
import { Blocklist } from '../components/Blocklist';
import { TierWeights } from '../components/TierWeights';
import { WebhookSecret } from '../components/WebhookSecret';

type Visibility = 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY';

interface Policy {
  viewVisibility: Visibility;
  submitMinTierId: string | null;
  upvoteMinTierId: string | null;
  hidePendingFromPublic: boolean;
  allowAnonymousTickets: boolean;
  allowReactions: boolean;
  acceptsCarryOver: boolean;
  allowVoteRatchet: boolean;
}

/**
 * Who can read the board, and what that costs the creator.
 *
 * Each option says what it *exposes* rather than what it is called. A creator choosing "anyone"
 * should know they are publishing a list of what they are watching, because that is the thing
 * being scraped to file fraudulent DMCA claims — and because "public" on its own sounds harmless.
 */
const VISIBILITY: Array<{ value: Visibility; label: string; exposes: string }> = [
  {
    value: 'SUBSCRIBERS_ONLY',
    label: 'Only my supporters',
    exposes:
      'Nobody outside your Patreon can read the board. This is the default, because a board anyone can read is a list of what you are watching — and those lists get scraped.',
  },
  {
    value: 'ANY_PATREON_USER',
    label: 'Anyone signed in to Patreon',
    exposes:
      'Anyone with a Patreon account, which is free to create. Against an automated reader this is no different from open to everyone.',
  },
  {
    value: 'PUBLIC',
    label: 'Anyone at all',
    exposes:
      'Open to the whole internet, indexable by search engines, readable without an account. Choose it if being found matters more than being quiet.',
  },
];

/**
 * The tier a supporter needs before they may do a thing.
 *
 * Kept apart from reading, which is the setting above: letting somebody see the board and letting
 * them add to it are different decisions, and a creator who wants an open board with a gated
 * suggestion box should not have to choose between them.
 */
const GATES: Array<{ key: 'submitMinTierId' | 'upvoteMinTierId'; label: string; hint: string }> = [
  {
    key: 'submitMinTierId',
    label: 'Who may suggest something',
    hint: 'The tier a supporter needs before they can add to the board.',
  },
  {
    key: 'upvoteMinTierId',
    label: 'Who may upvote',
    hint: 'Usually looser than suggesting: voting costs you nothing to moderate.',
  },
];

const SWITCHES: Array<{ key: keyof Policy; label: string; hint: string }> = [
  {
    key: 'hidePendingFromPublic',
    label: 'Hide suggestions awaiting review',
    hint: 'Nobody but you and your staff sees an entry until it has been accepted. Patrons still see their own.',
  },
  {
    key: 'allowAnonymousTickets',
    label: 'Let anyone message the moderators',
    hint: 'Off by default: a contact form open to people without accounts is the highest-value spam target here.',
  },
  {
    key: 'allowReactions',
    label: 'Allow reactions on entries',
    hint: 'The emoji row under each card.',
  },
  {
    key: 'acceptsCarryOver',
    label: 'Accept suggestions carried from other boards',
    hint: 'They arrive labelled, and land in the review queue like anything else.',
  },
  {
    key: 'allowVoteRatchet',
    label: 'Let patrons lift old votes to their current tier',
    hint: 'On by default: paying more, even once, is not meant to be taken back. Turn it off for a board that should reflect current support rather than past generosity.',
  },
];

/**
 * Everything a creator decides about their own board.
 *
 * Behind `MANAGE_POLICY`, which is a permission of its own rather than part of moderating.
 * Running the queue and deciding who may read the board are different powers: somebody who
 * arrived by invite link holds the first, and holds the second only if the creator granted it.
 * An owner holds it either way, by the role short-circuit in `hasPermission`.
 */
export function BoardSettings() {
  const { slug = '' } = useParams();
  const { creator, capabilities } = useCreator(slug);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'denied' | 'failed'>('loading');
  const [saved, setSaved] = useState<string | null>(null);

  const creatorId = creator?.id;
  // Ordered as the creator ordered them on Patreon, so the list reads the way their page does.
  const tiers = [...(creator?.tiers ?? [])].sort((a, b) => a.order - b.order);

  useEffect(() => {
    if (!creatorId) return;
    let cancelled = false;
    api
      .get<Policy>(`/creators/${creatorId}/policy`)
      .then((body) => {
        if (cancelled) return;
        setPolicy(body);
        setStatus('ready');
      })
      .catch((error: { status?: number }) => {
        if (cancelled) return;
        // 403 is the ordinary answer for a moderator, not a fault. Saying "something went wrong"
        // to somebody who simply does not hold this power is how a person files a bug report.
        setStatus(error?.status === 403 || error?.status === 401 ? 'denied' : 'failed');
      });
    return () => {
      cancelled = true;
    };
  }, [creatorId]);

  async function save(changes: Partial<Policy>) {
    if (!creatorId || !policy) return;
    const previous = policy;
    // Applied immediately, rolled back if the server disagrees. A settings switch that waits for
    // a round trip before moving feels broken on a slow connection.
    setPolicy({ ...policy, ...changes });
    setSaved(null);
    try {
      await api.patch<Policy>(`/creators/${creatorId}/policy`, changes);
      setSaved('Saved.');
    } catch {
      setPolicy(previous);
      setSaved('That did not save. Nothing changed.');
    }
  }

  if (status === 'loading') return <p className="p-4">Loading…</p>;
  if (status === 'denied')
    return (
      <p className="p-4">
        You do not have permission to change this board&apos;s settings. Running the board and
        deciding who may read it are separate — the creator can grant this from the moderators page.
      </p>
    );
  if (status === 'failed' || !policy) return <p className="p-4">Could not load the settings.</p>;

  return (
    <section className="max-w-prose">
      <h1 className="text-lg font-medium">Board settings</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        <Link to={`/c/${slug}`} className="underline">
          Back to the board
        </Link>
      </p>

      <fieldset className="mt-6">
        <legend className="text-sm font-medium">Who can read this board</legend>
        <div className="mt-2 space-y-3">
          {VISIBILITY.map((option) => (
            <label key={option.value} className="flex gap-2 text-sm">
              <input
                type="radio"
                name="visibility"
                className="mt-1"
                checked={policy.viewVisibility === option.value}
                onChange={() => save({ viewVisibility: option.value })}
              />
              <span>
                <span className="font-medium">{option.label}</span>
                {/* What it exposes, not what it is called. "Public" sounds harmless. */}
                <span className="block text-slate-600 dark:text-slate-300">{option.exposes}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-8">
        <legend className="text-sm font-medium">What it takes to take part</legend>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Reading is set above. These are separate: somebody can be allowed to read the board
          without being allowed to add to it.
        </p>
        <div className="mt-3 space-y-4">
          {GATES.map((gate) => (
            <div key={gate.key}>
              <label htmlFor={gate.key} className="block text-sm font-medium">
                {gate.label}
              </label>
              <select
                id={gate.key}
                value={(policy[gate.key] as string | null) ?? ''}
                onChange={(event) => save({ [gate.key]: event.target.value || null })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
              >
                {/*
                  An empty value is not "no requirement" — it drops the requirement to *any active
                  patron*, which is what the model means by a null gate. Labelling it "anyone"
                  would promise something the board does not do.
                */}
                <option value="">Any supporter, at any tier</option>
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.title} and above
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{gate.hint}</p>
            </div>
          ))}
          {tiers.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              No tiers have synced from Patreon yet, so there is nothing to gate on beyond being a
              supporter.
            </p>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="mt-8">
        <legend className="text-sm font-medium">What people can do here</legend>
        <div className="mt-2 space-y-3">
          {SWITCHES.map((setting) => (
            <label key={setting.key} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={policy[setting.key] as boolean}
                onChange={(event) => save({ [setting.key]: event.target.checked })}
              />
              <span>
                <span className="font-medium">{setting.label}</span>
                <span className="block text-slate-600 dark:text-slate-300">{setting.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/*
        Owner-level, and separate from everything above it.

        The blocklist decides what the board will accept at all, which is why the API files it
        under ADMINISTER rather than MANAGE_POLICY. Rendering it for a moderator who holds only
        MANAGE_POLICY would show them a section whose every request comes back 403.
      */}
      {capabilities.administer ? (
        <>
          {/*
            Owner-only, matching the API: deciding what a pledge is worth in the ranking is not a
            moderation power. Placed above the blocklist because it is the one setting here that
            changes what the board *shows* rather than what it accepts.
          */}
          <fieldset className="mt-8">
            <legend className="text-sm font-medium">What a vote from each tier counts for</legend>
            <TierWeights slug={slug} tiers={tiers} />
          </fieldset>

          <fieldset className="mt-8">
            <legend className="text-sm font-medium">Words this board will not accept</legend>
            <Blocklist slug={slug} />
          </fieldset>

          {/*
            Owner-only, like the blocklist above it and for a sharper reason: whoever holds this
            secret can forge membership events, minting active-patron status at any pledge for
            anyone on the campaign. A moderator holding MANAGE_POLICY must not see it.
          */}
          {creatorId ? (
            <fieldset className="mt-8">
              <legend className="text-sm font-medium">Patreon webhook</legend>
              <WebhookSecret creatorId={creatorId} />
            </fieldset>
          ) : null}
        </>
      ) : null}

      {saved ? (
        <p role="status" className="mt-6 text-sm text-slate-600 dark:text-slate-300">
          {saved}
        </p>
      ) : null}
    </section>
  );
}
