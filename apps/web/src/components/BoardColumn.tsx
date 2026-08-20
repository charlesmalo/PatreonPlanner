import { useCallback, useEffect, useState } from 'react';
import { useBoard } from '../api/hooks';
import { buildTree, type TreeNode } from './board-tree';
import { RecommendationCard } from './RecommendationCard';

interface BoardColumnProps {
  slug: string;
  status: string;
  label: string;
  theme: string | null;
  canUpvote: boolean;
  canModerate: boolean;
  /** Told when an entry leaves this column, so the destination can refetch. */
  onMoved: (id: string, status: string) => void;
  /** What an empty column says. Suggestions invites a submission; the rest simply say so. */
  emptyText?: string;
}

/** Per reader and local: which columns are folded away is not board configuration. */
const collapseKey = (slug: string, status: string) => `pp.board.${slug}.collapsed.${status}`;

/**
 * One kanban column, with its own cursor.
 *
 * Its own, rather than a slice of one board-wide list: a single keyset page ordered by upvotes can
 * be entirely one status, so a column sharing that list would show nothing while entries sat
 * further down a page nobody had fetched — and "Load more" would mean the board, not the column.
 */
const SORTS: Array<[string, string]> = [
  ['', 'Most upvoted'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
];

export function BoardColumn({
  slug,
  status,
  label,
  theme,
  canUpvote,
  canModerate,
  onMoved,
  emptyText = 'Nothing here yet.',
}: BoardColumnProps) {
  const [sort, setSort] = useState('');
  const board = useBoard(slug, true, theme, status, sort);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(collapseKey(slug, status)) === 'true');
  }, [slug, status]);

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(collapseKey(slug, status), String(next));
      return next;
    });
  }, [slug, status]);

  const renderNode = (node: TreeNode): JSX.Element => (
    <RecommendationCard
      key={node.item.id}
      slug={slug}
      recommendation={node.item}
      canUpvote={canUpvote}
      canModerate={canModerate}
      onCount={board.applyUpvote}
      onStatusChanged={(id, next) => {
        board.remove(id);
        onMoved(id, next);
      }}
    >
      {node.children.map((child) => renderNode(child))}
    </RecommendationCard>
  );

  return (
    <section
      aria-label={label}
      className={`flex flex-col rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40 ${
        collapsed ? 'w-14' : 'w-full sm:w-96 sm:shrink-0'
      }`}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className={`text-sm font-medium ${collapsed ? 'sr-only' : ''}`}>{label}</h2>
        <span className="flex items-center gap-2">
          {/* Kept when collapsed, so a folded column still says whether anything is in it. */}
          <span className="rounded bg-slate-200 px-1.5 text-xs dark:bg-slate-700">
            {board.items.length}
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
            className="rounded px-1 text-sm hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-700"
          >
            {collapsed ? '»' : '«'}
          </button>
        </span>
      </header>

      {collapsed ? null : (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          <label className="sr-only" htmlFor={`sort-${status}`}>
            Sort {label}
          </label>
          <select
            id={`sort-${status}`}
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          >
            {SORTS.map(([value, text]) => (
              <option key={value || 'default'} value={value}>
                {text}
              </option>
            ))}
          </select>
          {board.loading ? (
            <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
              Loading…
            </p>
          ) : board.items.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{emptyText}</p>
          ) : (
            <ul className="space-y-3">{buildTree(board.items).map((node) => renderNode(node))}</ul>
          )}

          {board.hasMore ? (
            <button
              type="button"
              onClick={board.loadMore}
              disabled={board.loadingMore}
              className="w-full rounded border border-slate-300 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {board.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
