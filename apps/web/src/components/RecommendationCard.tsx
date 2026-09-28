import { Link } from 'react-router-dom';
import type { Recommendation, StaffPermission } from '../api/types';

// Built here rather than stored, so the image size can change without a migration.
const POSTER_BASE = 'https://image.tmdb.org/t/p/w92';

import { AvailabilityBadges } from './AvailabilityBadges';
import { LinkCandidates } from './LinkCandidates';
import { PublishedLinks } from './PublishedLinks';
import { FlagButton } from './FlagButton';
import { FollowButton } from './FollowButton';
import { NoteList } from './NoteList';
import { PickButton } from './PickButton';
import { DRAG_TYPE } from './drag';
import { ReactionBar } from './ReactionBar';
import { GroupControl } from './GroupControl';
import { RedeemButton } from './RedeemButton';
import { StatusControl } from './StatusControl';
import { WatchOrderList } from './WatchOrderList';
import { UpvoteButton } from './UpvoteButton';

interface RecommendationCardProps {
  slug: string;
  recommendation: Recommendation;
  canUpvote: boolean;
  canModerate: boolean;
  /** Which staff controls to draw. The API checks each one again and refuses regardless. */
  permissions?: StaffPermission[];
  /** Which half of the reaction palette this reader may cast from. */
  isPremium?: boolean;
  onCount: (id: string, count: number, upvoted?: boolean) => void;
  onStatusChanged: (id: string, status: string) => void;
  /** Entries this one contains — a season under its show, a film under its franchise. */
  children?: React.ReactNode;
  /**
   * What this entry may be grouped into, already filtered by `groupTargets`.
   *
   * Supplied only by the board: grouping is a per-column decision and needs the column's tree to
   * know which entries carry members. Undefined everywhere else the card renders — a search hit
   * and an entry's own page have no column to group within — and the control is then absent
   * rather than offering a move with nothing to move into.
   */
  groupTargets?: Recommendation[];
  onGroupChanged?: () => void;
  /** This reader's balance. Zero draws no control — see `RedeemButton`. */
  tokensAvailable?: number;
  onRedeemed?: () => void;
  /**
   * `h1` when this card *is* the page — on an entry's own page the title is the document's
   * subject, and repeating it above the card would show it twice.
   */
  headingLevel?: 1 | 3;
}

export function RecommendationCard({
  slug,
  recommendation,
  headingLevel = 3,
  canUpvote,
  canModerate,
  permissions = [],
  isPremium = false,
  onCount,
  onStatusChanged,
  children,
  groupTargets,
  onGroupChanged,
  tokensAvailable = 0,
  onRedeemed,
}: RecommendationCardProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h3';
  return (
    // flex-wrap, and a floor on the content: a card nested inside another one inside a column is
    // narrow enough that the fixed-width upvote control and poster together left the text zero
    // width to occupy — present in the DOM, and invisible on the page.
    <li
      // Only for someone who could move it anyway. Dragging is a faster way to do what the
      // status menu on this card already does, never the only way — the menu is what works with
      // a keyboard, a screen reader, and on touch.
      draggable={canModerate}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          DRAG_TYPE,
          JSON.stringify({ id: recommendation.id, status: recommendation.status }),
        );
        event.dataTransfer.effectAllowed = 'move';
      }}
      className={`flex flex-wrap gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 ${
        canModerate ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
    >
      <UpvoteButton
        slug={slug}
        recommendationId={recommendation.id}
        title={recommendation.customTitle}
        upvoteCount={recommendation.upvoteCount}
        hasUpvoted={recommendation.hasUpvoted}
        canUpvote={canUpvote}
        onCount={onCount}
      />
      {recommendation.title?.posterPath ? (
        <img
          src={`${POSTER_BASE}${recommendation.title.posterPath}`}
          // Explicit dimensions and lazy loading: a board is a long list of images, and without
          // them each one shifts the layout as it arrives.
          width={46}
          height={69}
          loading="lazy"
          alt={`Poster for ${recommendation.title.name}`}
          className="h-[69px] w-[46px] shrink-0 rounded object-cover"
        />
      ) : null}
      <div className="min-w-[10rem] flex-1">
        {/* Rendered as text, never as HTML: every field here is submitter-controlled. */}
        <Heading
          className={
            headingLevel === 1 ? 'text-xl font-semibold break-words' : 'font-medium break-words'
          }
        >
          {/* Linked on the board, plain text on its own page — a heading that links to the
              page you are already on is a dead control. */}
          {headingLevel === 1 ? (
            recommendation.customTitle
          ) : (
            <Link
              to={`/c/${slug}/e/${recommendation.id}`}
              className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:decoration-slate-600"
            >
              {recommendation.customTitle}
            </Link>
          )}
          {recommendation.title?.year ? (
            <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
              ({recommendation.title.year})
            </span>
          ) : null}
        </Heading>
        {/* Only when it differs from the headcount. Two identical numbers side by side is noise,
            and a board that never weights its tiers should not have to read one. */}
        {typeof recommendation.weightedScore === 'number' &&
        recommendation.weightedScore !== recommendation.upvoteCount ? (
          <span className="mt-1 mr-2 inline-block text-xs text-slate-500 dark:text-slate-400">
            {recommendation.weightedScore} points from {recommendation.upvoteCount}{' '}
            {recommendation.upvoteCount === 1 ? 'patron' : 'patrons'}
          </span>
        ) : null}
        {recommendation.unconsumedRedeems > 0 ? (
          <span className="mt-1 ml-1 inline-block rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
            {/* The count, not just the badge: redeems stack, and "three people spent a token on
                this" is a different thing from "somebody did". */}
            Priority · {recommendation.unconsumedRedeems}
          </span>
        ) : null}
        {recommendation.isCreatorPick ? (
          <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            Creator pick
          </span>
        ) : null}
        {recommendation.description ? (
          <p className="mt-1 whitespace-pre-line break-words text-sm text-slate-600 dark:text-slate-300">
            {recommendation.description}
          </p>
        ) : null}
        {/*
          What the token was spent *on*. The count above says somebody wants this sooner; only
          this says which part of it, because nothing here models an episode and the sentence a
          patron wrote is the whole instruction.

          Rendered as text, never as markup — it is a stranger's words arriving on a creator's
          screen. Who may see which note is the API's decision, not this component's: it renders
          what it was given.
        */}
        {(recommendation.redeems ?? []).length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {(recommendation.redeems ?? []).map((redeem) => (
              <li key={redeem.id} className="break-words text-xs text-sky-800 dark:text-sky-300">
                <span className="font-medium">Redeemed:</span> {redeem.note}
                <span className="text-slate-500 dark:text-slate-400">
                  {' '}
                  — {redeem.user.fullName ?? 'a patron'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <PublishedLinks
          slug={slug}
          links={recommendation.links ?? []}
          canModerate={canModerate}
          permissions={permissions ?? []}
        />
        {/* Defensive `?? []` for the reason `themes` and `notes` carry one: a card renders from
            both the board projection and a submit response, and a shape mismatch between them
            should cost this strip, not the page. */}
        <LinkCandidates
          slug={slug}
          candidates={recommendation.candidateLinks ?? []}
          canModerate={canModerate}
          permissions={permissions}
        />
        <WatchOrderList items={recommendation.watchOrderItems} />
        <NoteList notes={recommendation.notes ?? []} />
        <AvailabilityBadges
          availability={recommendation.availability}
          title={recommendation.customTitle}
        />
        {/* Defensive `?? []`: a card is rendered from both the board projection and a submit
            response, and a shape mismatch between them should cost a chip strip, not the page. */}
        {(recommendation.themes ?? []).length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {(recommendation.themes ?? []).map((theme) => (
              <li
                key={theme.id}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] dark:bg-slate-800"
              >
                {/* Text, never markup: theme names are creator-editable. */}
                {theme.name}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Suggested by {recommendation.submittedBy.fullName ?? 'a patron'}
        </p>
        {Array.isArray(children) && children.length > 0 ? (
          <ul className="mt-3 space-y-2 border-l border-slate-200 pl-3 dark:border-slate-700">
            {children}
          </ul>
        ) : null}
        <ReactionBar
          isPremium={isPremium}
          slug={slug}
          recommendationId={recommendation.id}
          title={recommendation.customTitle}
          reactions={recommendation.reactions ?? []}
          canReact={canUpvote}
        />
        <div className="mt-2 flex flex-wrap items-start gap-3">
          {/* Offered to every reader: the API answers an anonymous report with a 401, and
              FlagButton turns that into "sign in to report" — more useful than no control. */}
          {canUpvote ? (
            <FollowButton
              slug={slug}
              recommendationId={recommendation.id}
              title={recommendation.customTitle}
              following={recommendation.following ?? false}
            />
          ) : null}
          <FlagButton
            slug={slug}
            recommendationId={recommendation.id}
            title={recommendation.customTitle}
          />
          {/* `pick` requires MOVE_ENTRIES too, so the same gate as the Move control below. */}
          {canModerate && permissions?.includes('MOVE_ENTRIES') ? (
            <PickButton
              slug={slug}
              recommendationId={recommendation.id}
              title={recommendation.customTitle}
              isPick={recommendation.isCreatorPick ?? false}
            />
          ) : null}
          {/*
            MOVE_ENTRIES, not merely MODERATE. The API requires the permission on every status
            endpoint, so a moderator without it saw the control, pressed it, and got a 403 with
            the entry silently staying put — which is what an invite grants until the creator
            says otherwise, so it was the default experience for an invited moderator.

            Optional chaining for the same reason as elsewhere: this runs inside render, and a
            capabilities payload without `permissions` would blank the board rather than hide a
            button.
          */}
          {/* Only an accepted entry can be redeemed: the API refuses anything else, and a
              control that is always refused is worse than none. The balance does the rest of the
              gating inside the button. */}
          {recommendation.status === 'ACCEPTED' && onRedeemed ? (
            <RedeemButton
              slug={slug}
              recommendationId={recommendation.id}
              title={recommendation.customTitle}
              available={tokensAvailable}
              onRedeemed={onRedeemed}
            />
          ) : null}
          {/* Grouping is MOVE_ENTRIES on both endpoints — the same gate, for the same reason. */}
          {canModerate &&
          permissions?.includes('MOVE_ENTRIES') &&
          groupTargets &&
          onGroupChanged ? (
            <GroupControl
              slug={slug}
              entry={recommendation}
              targets={groupTargets}
              onChanged={onGroupChanged}
            />
          ) : null}
          {canModerate && permissions?.includes('MOVE_ENTRIES') ? (
            <StatusControl
              slug={slug}
              recommendationId={recommendation.id}
              title={recommendation.customTitle}
              status={recommendation.status}
              onChanged={onStatusChanged}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}
