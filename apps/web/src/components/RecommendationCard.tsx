import { Link } from 'react-router-dom';
import type { Recommendation } from '../api/types';

// Built here rather than stored, so the image size can change without a migration.
const POSTER_BASE = 'https://image.tmdb.org/t/p/w92';

/**
 * The API restricts link URLs to http(s) at submit time. This repeats the check at the one place
 * attacker input becomes an attribute, so a future API regression is not immediately exploitable
 * — React only warns on a javascript: href, it does not block it.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
import { AvailabilityBadges } from './AvailabilityBadges';
import { FlagButton } from './FlagButton';
import { NoteList } from './NoteList';
import { PickButton } from './PickButton';
import { ReactionBar } from './ReactionBar';
import { StatusControl } from './StatusControl';
import { WatchOrderList } from './WatchOrderList';
import { UpvoteButton } from './UpvoteButton';

interface RecommendationCardProps {
  slug: string;
  recommendation: Recommendation;
  canUpvote: boolean;
  canModerate: boolean;
  onCount: (id: string, count: number, upvoted?: boolean) => void;
  onStatusChanged: (id: string, status: string) => void;
  /** Entries this one contains — a season under its show, a film under its franchise. */
  children?: React.ReactNode;
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
  onCount,
  onStatusChanged,
  children,
}: RecommendationCardProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h3';
  return (
    // flex-wrap, and a floor on the content: a card nested inside another one inside a column is
    // narrow enough that the fixed-width upvote control and poster together left the text zero
    // width to occupy — present in the DOM, and invisible on the page.
    <li className="flex flex-wrap gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
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
        {recommendation.links.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-3">
            {recommendation.links
              .filter((link) => isSafeHttpUrl(link.url))
              .map((link, index) => (
                <li key={`${link.url}-${index}`}>
                  <a
                    href={link.url}
                    target="_blank"
                    // The URL is entirely submitter-chosen, so the opened page must not get a
                    // handle on this one.
                    rel="noopener noreferrer"
                    className="break-all text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
                  >
                    {link.label ?? link.url}
                  </a>
                </li>
              ))}
          </ul>
        ) : null}
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
          slug={slug}
          recommendationId={recommendation.id}
          title={recommendation.customTitle}
          reactions={recommendation.reactions ?? []}
          canReact={canUpvote}
        />
        <div className="mt-2 flex flex-wrap items-start gap-3">
          {/* Offered to every reader: the API answers an anonymous report with a 401, and
              FlagButton turns that into "sign in to report" — more useful than no control. */}
          <FlagButton
            slug={slug}
            recommendationId={recommendation.id}
            title={recommendation.customTitle}
          />
          {canModerate ? (
            <PickButton
              slug={slug}
              recommendationId={recommendation.id}
              title={recommendation.customTitle}
              isPick={recommendation.isCreatorPick ?? false}
            />
          ) : null}
          {canModerate ? (
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
