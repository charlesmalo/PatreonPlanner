import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCreator, useSession, useThemes, useViewMode } from '../api/hooks';
import { useTokens } from '../api/use-tokens';
import { hydrate, localThemes, rememberThemes } from '../api/board-settings';
import { encodeGroups } from '../components/label-groups';
import { narrowCapabilities } from '../api/view-mode';
import { BoardTabs } from '../components/BoardTabs';
import { ContactForm } from '../components/ContactForm';
import { ModeBanner } from '../components/ModeBanner';
import { ViewModeSwitch } from '../components/ViewModeSwitch';
import { BoardColumn } from '../components/BoardColumn';
import { SubmitForm } from '../components/SubmitForm';

/**
 * Design §7's patron board: Suggestions, Accepted, Now Playing, Completed. Rejected and Deleted
 * are absent by design — a patron never sees them, and a moderator reads them in the review
 * queue, which is the surface built for the bin.
 */
const OPENING_COLUMN_KEY = (slug: string) => `pp.board.${slug}.column`;

/**
 * Which column this board opens on.
 *
 * Remembered per board rather than globally: somebody moderating one board lives in Suggestions,
 * and reading another they follow they want Now Playing. Falls back to the first column, which is
 * where a board with nothing on it has the only thing worth seeing.
 */
function openingColumn(slug: string): number {
  try {
    const stored = window.localStorage.getItem(OPENING_COLUMN_KEY(slug));
    const found = COLUMNS.findIndex(([status]) => status === stored);
    return found === -1 ? 0 : found;
  } catch {
    return 0;
  }
}

function rememberColumn(slug: string, status: string): void {
  try {
    window.localStorage.setItem(OPENING_COLUMN_KEY(slug), status);
  } catch {
    // The board still works; only which column it opens on is forgotten.
  }
}

const COLUMNS: Array<[string, string]> = [
  ['PENDING', 'Suggestions'],
  ['ACCEPTED', 'Accepted'],
  ['ACTIVE', 'Now Playing'],
  ['COMPLETED', 'Completed'],
];

export function CreatorBoard() {
  const { slug = '' } = useParams();
  const { creator, capabilities: granted, error, loading } = useCreator(slug);
  // Read here rather than in each card: the reaction bar renders once per entry, and a hook that
  // fetches would turn one question into one request per card.
  const { user } = useSession();
  const { mode, needsAck, choose } = useViewMode(slug);
  // Applied once, here, rather than at each gate: a call site that forgot would keep offering a
  // control the reader asked not to see. Narrowing only — see `narrowCapabilities`.
  const capabilities = narrowCapabilities(granted, mode);
  const [themeIds, setThemeIds] = useState<string[][]>(() => localThemes(slug));
  /**
   * Whether the remembered filter has been checked against the labels the board actually has.
   *
   * A stored filter can name a label merged away or deleted since, and sending that id has the
   * server refuse the whole filter — a 404 on load, for a choice the reader may not remember
   * making. So nothing is sent until the label list arrives and the dead ids are gone.
   *
   * Starts true when there is no stored filter, which is the common case: there is nothing to
   * validate, so the first fetch is the filtered one and no request is wasted.
   */
  const [validated, setValidated] = useState(() => localThemes(slug).length === 0);
  const themes = useThemes(slug, !loading && !error);
  // Reading a balance is also what grants it — see `useTokens`. Only once the board is readable:
  // a signed-out visitor has no balance, and asking would be a 401 on every public board.
  const tokens = useTokens(slug, !loading && !error && user !== null);

  // A remembered filter can name a label that has since been merged away or deleted on the themes
  // page. Sending it would have the server refuse the whole filter and 404 the board on load, so
  // the dead ids are dropped once the live list arrives — silently, because a reader returning to
  // a board does not need an error about a label they may not remember choosing.
  //
  // Compared as encoded strings so an unchanged filter keeps its identity and this does not loop.
  useEffect(() => {
    if (themes.length === 0) return;
    const live = new Set(themes.map((theme) => theme.id));
    setThemeIds((current) => {
      const pruned = current
        .map((group) => group.filter((id) => live.has(id)))
        .filter((group) => group.length > 0);
      if (encodeGroups(pruned) === encodeGroups(current)) return current;
      void rememberThemes(slug, pruned);
      return pruned;
    });
    setValidated(true);
  }, [themes, slug]);
  // Bumped when a submission lands or a card moves, which remounts the columns so they refetch.
  // Each column owns its own cursor, so an entry leaving one has to be picked up by another —
  // threading every mutation through four independent lists would be more code for less
  // certainty.
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((current) => current + 1);

  // Brings a stored arrangement down from the server, then remounts the columns so they pick it
  // up. Deliberately after the first paint rather than before it: the board renders immediately
  // from the local copy, and on the same device the two already agree so nothing moves. Only a
  // reader who arranged this board elsewhere sees it change, which is the feature working.
  useEffect(() => {
    let cancelled = false;
    void hydrate(slug).then((changed) => {
      if (changed && !cancelled) setRevision((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return <p role="status">Loading board…</p>;
  }

  if (error) {
    return <BoardError status={error.status} />;
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{creator?.displayName}</h1>
        {/* Offered only to someone who has moderator powers to give up. */}
        {granted.moderate ? (
          <ViewModeSwitch mode={mode} onChange={choose} needsAck={needsAck} />
        ) : null}
        {capabilities.administer ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/staff`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Moderators
          </Link>
        ) : null}
        {/* Optional chaining, not decoration: this runs inside render, and a capabilities payload
            without `permissions` — a cached response, an API mid-deploy — would throw here and
            blank the entire board. The failure is a white page, not a missing link. */}
        {capabilities.permissions?.includes('MANAGE_POLICY') ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/settings`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Settings
          </Link>
        ) : null}
        {/* Same optional chaining as above, and for the same reason. */}
        {capabilities.permissions?.includes('MANAGE_THEMES') ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/themes`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Themes
          </Link>
        ) : null}
        {capabilities.upvote ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/my-votes`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Your votes
          </Link>
        ) : null}
        {/*
          HANDLE_REPORTS, not merely MODERATE: the tickets list and the review queue are on a
          controller that demands the permission, so a moderator without it followed either link
          into a refusal — the queue claiming they did not moderate a board they do moderate.
        */}
        {capabilities.moderate && capabilities.permissions?.includes('HANDLE_REPORTS') ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/tickets`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Messages
          </Link>
        ) : null}
        {capabilities.moderate && capabilities.permissions?.includes('HANDLE_REPORTS') ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/review`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Review queue
          </Link>
        ) : null}
      </div>

      <ModeBanner mode={mode} />

      {/* Below the board, not above it: most readers came to read, and a contact form at the top
          would push what they came for down the page. */}

      {capabilities.submit ? (
        <div className="mt-6">
          <SubmitForm
            slug={slug}
            onCreated={refresh}
            canUpvote={capabilities.upvote}
            onUpvoted={refresh}
          />
        </div>
      ) : null}

      {/* One column at a time. Four side by side truncated every one of them at laptop width;
          this gives whichever is being read the whole screen. */}
      <BoardTabs
        tabs={COLUMNS.map(([status, label]) => ({ status, label }))}
        initialIndex={openingColumn(slug)}
        onChange={(index) => rememberColumn(slug, COLUMNS[index][0])}
      >
        {(tab) => (
          <BoardColumn
            key={`${tab.status}-${revision}`}
            slug={slug}
            status={tab.status}
            label={tab.label}
            themes={themes}
            selectedThemes={validated ? themeIds : []}
            tokensAvailable={tokens.enabled ? tokens.available : 0}
            onRedeemed={() => {
              void tokens.refresh();
              refresh();
            }}
            onSelectThemes={(next) => {
              setThemeIds(next);
              void rememberThemes(slug, next);
            }}
            canUpvote={capabilities.upvote}
            canModerate={capabilities.moderate}
            permissions={capabilities.permissions}
            isPremium={user?.isPremium ?? false}
            onMoved={refresh}
            emptyText={
              tab.status === 'PENDING'
                ? `Nothing suggested yet.${capabilities.submit ? ' Be the first.' : ''}`
                : undefined
            }
          />
        )}
      </BoardTabs>

      {capabilities.contact ? (
        <div className="mt-8 max-w-prose">
          <ContactForm slug={slug} />
        </div>
      ) : null}
    </section>
  );
}

function BoardError({ status }: { status: number }) {
  // The server decides; this only explains its answer in terms the reader can act on.
  const text =
    status === 404
      ? 'No creator with that address.'
      : status === 401
        ? 'Sign in to see this board.'
        : status === 403
          ? 'This board is for the creator’s patrons.'
          : 'Could not load this board. Try again.';
  return (
    <p role="status" className="mt-3 text-slate-600 dark:text-slate-300">
      {text}
    </p>
  );
}
