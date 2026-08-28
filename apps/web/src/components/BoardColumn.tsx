import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { StaffPermission } from '../api/types';
import { localCollapsed, localSort, remember } from '../api/board-settings';
import { useBoard } from '../api/hooks';
import { readDrag } from './drag';
import { buildTree, type TreeNode } from './board-tree';
import { RecommendationCard } from './RecommendationCard';

interface BoardColumnProps {
  slug: string;
  status: string;
  label: string;
  theme: string | null;
  canUpvote: boolean;
  canModerate: boolean;
  /** Which staff controls the cards may draw. The API checks each one again. */
  permissions: StaffPermission[];
  /** Which half of the reaction palette this reader may cast from. */
  isPremium: boolean;
  /** Told when an entry leaves this column, so the destination can refetch. */
  onMoved: (id: string, status: string) => void;
  /** What an empty column says. Suggestions invites a submission; the rest simply say so. */
  emptyText?: string;
}

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
  // Last, and never the default: the board is a demand signal first, and a hand-made order is
  // an override of that rather than a replacement for it.
  ['manual', 'In the order you arrange'],
];

export function BoardColumn({
  slug,
  status,
  label,
  theme,
  canUpvote,
  canModerate,
  permissions,
  isPremium,
  onMoved,
  emptyText = 'Nothing here yet.',
}: BoardColumnProps) {
  const [sort, setSort] = useState(() => localSort(slug, status));
  const [dragOver, setDragOver] = useState(false);

  const chooseSort = (next: string) => {
    setSort(next);
    void remember(slug, status, { sort: next });
  };
  const board = useBoard(slug, true, theme, status, sort);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localCollapsed(slug, status));
  }, [slug, status]);

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      void remember(slug, status, { collapsed: next });
      return next;
    });
  }, [slug, status]);

  /** A card dropped from another column: the same status change the menu makes. */
  async function moveHere(id: string) {
    try {
      await api.post(`/creators/${encodeURIComponent(slug)}/recommendations/${id}/status`, {
        status,
      });
    } finally {
      // Refetched either way: a refused move corrects itself rather than lying.
      onMoved(id, status);
    }
  }

  /** A card dropped onto another card, in manual sort: a position between its neighbours. */
  async function placeBefore(id: string, beforeId: string) {
    const order = board.items.map((item) => item.id);
    const target = order.indexOf(beforeId);
    const afterId = target > 0 ? order[target - 1] : undefined;
    if (id === beforeId || id === afterId) return;
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/recommendations/${id}/rank`, {
        ...(afterId ? { afterId } : {}),
        beforeId,
      });
    } finally {
      onMoved(id, status);
    }
  }

  const renderNode = (node: TreeNode): JSX.Element => (
    <RecommendationCard
      key={node.item.id}
      slug={slug}
      recommendation={node.item}
      canUpvote={canUpvote}
      canModerate={canModerate}
      permissions={permissions}
      isPremium={isPremium}
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
      onDragOver={(event) => {
        if (!canModerate) return;
        // Preventing the default is what marks this a valid drop target; without it the browser
        // refuses the drop and nothing happens.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (!canModerate) return;
        event.preventDefault();
        setDragOver(false);
        const dragged = readDrag(event.dataTransfer);
        if (!dragged) return;
        if (dragged.status !== status) {
          // Between columns: a status change, through the same endpoint the menu uses. No second
          // write path, and no second set of rules to keep in step.
          void moveHere(dragged.id);
        }
        // Within a column, position is only meaningful in manual sort — in any other, the order
        // is computed, and preserving a hand-placed position would be a promise the next render
        // breaks. The card list below handles that case, where it knows the neighbours.
      }}
      className={`flex flex-col rounded-lg border bg-slate-50 dark:bg-slate-900/40 ${
        dragOver
          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
          : 'border-slate-200 dark:border-slate-800'
      } ${collapsed ? 'w-14' : 'w-full sm:w-96 sm:shrink-0'}`}
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
            onChange={(event) => chooseSort(event.target.value)}
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
            <ul className="space-y-3">
              {buildTree(board.items).map((node) => (
                <div
                  key={node.item.id}
                  onDragOver={(event) => {
                    // Only in manual sort: anywhere else the order is computed, so a hand-placed
                    // position would not survive the next render.
                    if (canModerate && sort === 'manual') event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!canModerate || sort !== 'manual') return;
                    const dragged = readDrag(event.dataTransfer);
                    if (!dragged || dragged.status !== status) return;
                    // Handled here rather than by the column, which cannot know the neighbours.
                    event.stopPropagation();
                    event.preventDefault();
                    void placeBefore(dragged.id, node.item.id);
                  }}
                >
                  {renderNode(node)}
                </div>
              ))}
            </ul>
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
