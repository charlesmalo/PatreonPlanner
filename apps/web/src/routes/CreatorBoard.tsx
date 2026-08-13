import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useBoard, useCreator, useThemes } from '../api/hooks';
import type { Recommendation } from '../api/types';
import { RecommendationCard } from '../components/RecommendationCard';
import { SubmitForm } from '../components/SubmitForm';
import { ThemeFilter } from '../components/ThemeFilter';

/**
 * Design §7's patron board: Suggestions, Accepted, Now Playing, Completed. Rejected and Deleted
 * are absent by design — a patron never sees them, and a moderator reads them in the review
 * queue, which is the surface built for the bin.
 */
const COLUMNS: Array<[string, string]> = [
  ['PENDING', 'Suggestions'],
  ['ACCEPTED', 'Accepted'],
  ['ACTIVE', 'Now Playing'],
  ['COMPLETED', 'Completed'],
];

export function CreatorBoard() {
  const { slug = '' } = useParams();
  const { creator, capabilities, error, loading } = useCreator(slug);
  const [theme, setTheme] = useState<string | null>(null);
  const themes = useThemes(slug, !loading && !error);
  const board = useBoard(slug, !loading && !error, theme);

  if (loading) {
    return <p role="status">Loading board…</p>;
  }

  if (error) {
    return <BoardError status={error.status} />;
  }

  // Children are rendered inside their parent, so they must not also appear at the top level.
  // Only within the same column: columns are the lifecycle, and nesting a pending entry inside
  // an accepted one would move it out of the column its status says it belongs to.
  const columns = COLUMNS.map(([status, label]) => {
    const inColumn = board.items.filter((item) => item.status === status);
    return [status, label, buildTree(inColumn)] as const;
    // An empty column renders nothing at all: four headings over three empty lists reads as a
    // broken page rather than an empty one.
  }).filter(([, , roots]) => roots.length > 0);

  // Recursive, so an entry nested more than one deep is rendered rather than silently dropped.
  // Nested markup rather than a margin, so the containment reaches a screen reader too.
  const renderNode = (node: TreeNode): JSX.Element => (
    <RecommendationCard
      key={node.item.id}
      slug={slug}
      recommendation={node.item}
      canUpvote={capabilities.upvote}
      canModerate={capabilities.moderate}
      onCount={board.applyUpvote}
      onStatusChanged={board.applyStatus}
    >
      {node.children.map((child) => renderNode(child))}
    </RecommendationCard>
  );

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{creator?.displayName}</h1>
        {capabilities.administer ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/staff`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Moderators
          </Link>
        ) : null}
        {capabilities.moderate ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/review`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Review queue
          </Link>
        ) : null}
      </div>

      <ThemeFilter themes={themes} selected={theme} onSelect={setTheme} />

      {capabilities.submit ? (
        <div className="mt-6">
          <SubmitForm slug={slug} onCreated={board.prepend} />
        </div>
      ) : null}

      {board.loading ? (
        <p role="status" className="mt-8 text-slate-600 dark:text-slate-300">
          Loading suggestions…
        </p>
      ) : board.error ? (
        <BoardError status={board.error.status} />
      ) : columns.length === 0 ? (
        <>
          <h2 className="mt-8 text-lg font-medium">Suggestions</h2>
          <p className="mt-3 text-slate-600 dark:text-slate-300">
            {/* Keyed on the rendered columns, not the raw item count: a staff viewer whose page
                holds only rejected or deleted entries has items but no column to show them in,
                and rendered a page with nothing on it at all. */}
            {board.items.length === 0
              ? `Nothing suggested yet. ${capabilities.submit ? 'Be the first.' : ''}`
              : 'Nothing on the board — the entries here are in the review queue.'}
          </p>
        </>
      ) : (
        <>
          {columns.map(([status, label, roots]) => (
            <div key={status}>
              <h2 className="mt-8 text-lg font-medium">{label}</h2>
              <ul className="mt-3 space-y-3">{roots.map((node) => renderNode(node))}</ul>
            </div>
          ))}
          {/* Kept mounted and disabled rather than unmounted: removing a focused button drops
              keyboard focus to the body, losing the reader's place on the last page. */}
          <button
            type="button"
            onClick={board.loadMore}
            disabled={board.loadingMore || !board.hasMore}
            className="mt-4 rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {board.loadingMore ? 'Loading…' : board.hasMore ? 'Load more' : 'No more suggestions'}
          </button>
          <p
            role="status"
            aria-live="polite"
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            {board.moreError}
          </p>
        </>
      )}
    </section>
  );
}

interface TreeNode {
  item: Recommendation;
  children: TreeNode[];
}

/**
 * Groups a column's entries into a tree by `parentId`.
 *
 * Defensive on purpose. The API only ever produces one level today, but rendering just roots and
 * their direct children *dropped* anything deeper, and a cycle left no roots at all and made the
 * whole column disappear. Losing entries is far worse than rendering them flat, so anything the
 * walk cannot place is promoted to the top level.
 */
function buildTree(items: Recommendation[]): TreeNode[] {
  const nodes = new Map(items.map((item) => [item.id, { item, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.item.parentId ? nodes.get(node.item.parentId) : undefined;
    // A parent outside this column, or a cycle, means this entry stands on its own.
    if (parent && parent !== node && !descendsFrom(parent, node, nodes)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function descendsFrom(
  candidate: TreeNode,
  ancestor: TreeNode,
  nodes: Map<string, TreeNode>,
): boolean {
  const seen = new Set<string>();
  let current: TreeNode | undefined = candidate;
  while (current && !seen.has(current.item.id)) {
    if (current === ancestor) return true;
    seen.add(current.item.id);
    current = current.item.parentId ? nodes.get(current.item.parentId) : undefined;
  }
  return false;
}

export type { Recommendation };

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
