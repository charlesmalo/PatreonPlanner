import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Recommendation, StaffPermission, ThemeSummary } from '../api/types';
import { localCollapsed, localSort, remember } from '../api/board-settings';
import { useBoard } from '../api/hooks';
import { readDrag, type DraggedEntry } from './drag';
import { buildTree, type TreeNode } from './board-tree';
import { groupTargets } from './group-targets';
import { ThemeFilter } from './ThemeFilter';
import { RecommendationCard } from './RecommendationCard';

interface BoardColumnProps {
  slug: string;
  status: string;
  label: string;
  /** Which country's streaming offers to attach. Null means the server's own default. */
  region?: string | null;
  /** Every label on the board, for the filter this column renders. */
  themes: ThemeSummary[];
  /**
   * Shared across columns rather than held per column: the selection belongs to the reader's view
   * of the board, so swapping tabs keeps whatever they were narrowing by.
   */
  selectedThemes: string[][];
  onSelectThemes: (groups: string[][]) => void;
  /** This reader's token balance on the board, or zero when tokens are off or they hold none. */
  tokensAvailable?: number;
  onRedeemed?: () => void;
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
  ['', 'Top rated'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  // Last, and never the default: the board is a demand signal first, and a hand-made order is
  // an override of that rather than a replacement for it.
  ['manual', 'In the order you arrange'],
];

export function BoardColumn({
  slug,
  region,
  status,
  label,
  themes,
  selectedThemes,
  onSelectThemes,
  tokensAvailable = 0,
  onRedeemed,
  canUpvote,
  canModerate,
  permissions,
  isPremium,
  onMoved,
  emptyText = 'Nothing here yet.',
}: BoardColumnProps) {
  // `rank` requires MOVE_ENTRIES, exactly as the status endpoints do — so dragging a card is
  // offered on the same terms as the Move control beside it. Gated on the capability alone, a
  // moderator without the permission could drag a card and watch it spring back on a 403.
  const canMove = canModerate && (permissions ?? []).includes('MOVE_ENTRIES');
  const [sort, setSort] = useState(() => localSort(slug, status));
  const [dragOver, setDragOver] = useState(false);
  /**
   * The card currently being dragged, so the grouping bands know whether to appear.
   *
   * Read from the bubbled `dragstart`: the card sets the payload in its own handler, and this one
   * runs after it on the way up. `dragstart` is the only moment the drag data store is readable —
   * by `dragover` the browser has put it in protected mode, which is exactly when the bands need
   * to decide whether to show.
   *
   * React state rather than a module variable, because the bands are rendered output: a value
   * nothing subscribes to would be set and never painted. A first version did exactly that, and
   * the band never appeared.
   */
  const [dragging, setDragging] = useState<DraggedEntry | null>(null);

  const chooseSort = (next: string) => {
    setSort(next);
    void remember(slug, status, { sort: next });
  };
  const board = useBoard(slug, true, selectedThemes, status, sort, region);
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

  /** A card dropped onto another card's grouping band: one entry put inside another. */
  async function groupInto(id: string, intoId: string) {
    try {
      await api.post(`/creators/${encodeURIComponent(slug)}/recommendations/${id}/group`, {
        intoId,
      });
    } finally {
      // Refetched either way, like every other drop: the head's de-duplicated total changes, and
      // a refused group corrects itself rather than leaving the board showing a nesting that is
      // not there.
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

  /**
   * A filtered column that finds nothing has not failed — it has answered. Saying which labels it
   * asked for turns a blank column into that answer, and costs nothing the API has to learn.
   *
   * Worth the sentence because an AND group is narrow by construction: on a real board most pairs
   * of labels never co-occur, so "nothing here" is the *common* outcome of combining two and
   * reads as a bug without it.
   */
  const filteredEmptyText = () => {
    if (selectedThemes.length === 0) return emptyText;
    const names = (ids: string[]) =>
      ids.map((id) => themes.find((theme) => theme.id === id)?.name ?? id);
    const [first] = selectedThemes;
    if (selectedThemes.length === 1 && first.length > 1) {
      const parts = names(first);
      return `No entries carry both ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
    }
    return `Nothing here matches ${selectedThemes
      .map((group) => names(group).join(' and '))
      .join(', or ')}.`;
  };

  const tree = buildTree(board.items);

  /**
   * Which entries carry a group, read off the tree rather than the card.
   *
   * A card does not know its own children — nesting is a projection over the column — so the
   * only place that can answer is the one holding the built tree. The API refuses to group an
   * entry that already heads one, so this is what keeps the menu from offering moves it would
   * refuse.
   */
  const headIds = new Set(
    tree.filter((node) => node.children.length > 0).map((node) => node.item.id),
  );
  const targetsFor = (item: Recommendation) =>
    groupTargets(item, board.items, (id) => headIds.has(id));

  /**
   * Whether the band under `targetId` should be offered for the entry being dragged.
   *
   * Looks the dragged entry up rather than synthesising one from its id: `groupTargets` reads
   * whatever it needs off the entry, and a stand-in carrying only an id would keep type-checking
   * while quietly answering a different question the day it reads one more field.
   */
  const canGroupInto = (draggedId: string, targetId: string) => {
    const dragged = board.items.find((item) => item.id === draggedId);
    return dragged ? targetsFor(dragged).some((t) => t.id === targetId) : false;
  };

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
      tokensAvailable={tokensAvailable}
      onRedeemed={onRedeemed}
      groupTargets={canMove ? targetsFor(node.item) : undefined}
      onGroupChanged={canMove ? () => onMoved(node.item.id, status) : undefined}
    >
      {node.children.map((child) => renderNode(child))}
    </RecommendationCard>
  );

  return (
    <section
      aria-label={label}
      // Bubbled from the card that started it, which has already called setData by the time this
      // runs. The only moment the payload is readable — see `dragging` above.
      onDragStart={(event) => setDragging(readDrag(event.dataTransfer))}
      // Fires even when a drag is abandoned outside any drop target, so the bands always clear.
      onDragEnd={() => setDragging(null)}
      onDragOver={(event) => {
        if (!canMove) return;
        // Preventing the default is what marks this a valid drop target; without it the browser
        // refuses the drop and nothing happens.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (!canMove) return;
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
      } ${collapsed ? 'w-14' : 'w-full'}`}
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

          {/* Inside the column, not above the tabs: the filter narrows what is directly beneath
              it, and a control sitting above four tabs gave no clue which one it acted on. The
              selection itself is shared, so swapping tabs keeps it. */}
          <ThemeFilter themes={themes} selected={selectedThemes} onChange={onSelectThemes} />
          {board.loading ? (
            <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
              Loading…
            </p>
          ) : board.items.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{filteredEmptyText()}</p>
          ) : (
            <ul className="space-y-3">
              {tree.map((node) => (
                <div
                  key={node.item.id}
                  onDragOver={(event) => {
                    // Only in manual sort: anywhere else the order is computed, so a hand-placed
                    // position would not survive the next render.
                    if (canMove && sort === 'manual') event.preventDefault();
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
                  <GroupDropBand
                    canMove={canMove}
                    status={status}
                    target={node.item}
                    dragged={dragging}
                    canGroupInto={canGroupInto}
                    onGroup={groupInto}
                  />
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

/**
 * The drop target that turns a drag into a group, shown only while one is in progress.
 *
 * A separate band rather than the card itself, because dropping *on* a card already means
 * something: in manual sort it places the card between its neighbours. Overloading one gesture
 * with two meanings that differ by a sort dropdown is how a board becomes unpredictable. This
 * appears beneath the card only while a valid drag is happening, so the gesture is discoverable
 * exactly when it applies and invisible the rest of the time.
 *
 * Same column only: a drag from elsewhere carries a different status, and a child whose head is
 * in another column renders as a normal top-level card while its votes count toward a head the
 * reader cannot see. The board would be showing a total with no visible cause.
 */
function GroupDropBand({
  canMove,
  status,
  target,
  dragged,
  canGroupInto,
  onGroup,
}: {
  canMove: boolean;
  status: string;
  target: Recommendation;
  dragged: DraggedEntry | null;
  canGroupInto: (draggedId: string, targetId: string) => boolean;
  onGroup: (id: string, intoId: string) => void;
}) {
  const [over, setOver] = useState(false);

  // Nothing is being dragged, it came from another column, or this card is not somewhere it may
  // go. The same filter the menu uses, so the band and the menu can never disagree.
  if (
    !canMove ||
    !dragged ||
    dragged.status !== status ||
    dragged.id === target.id ||
    !canGroupInto(dragged.id, target.id)
  ) {
    return null;
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const entry = readDrag(event.dataTransfer);
        if (!entry || entry.status !== status || entry.id === target.id) return;
        // Stopped so the card's own reorder drop does not also fire.
        event.stopPropagation();
        event.preventDefault();
        onGroup(entry.id, target.id);
      }}
      className={`mt-1 rounded border border-dashed px-2 py-1 text-center text-xs ${
        over
          ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
          : 'border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400'
      }`}
    >
      {/* Text, never markup: a title is a stranger's words. */}
      Group into “{target.customTitle}”
    </div>
  );
}
