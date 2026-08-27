import { api } from './client';

export interface BoardSettings {
  collapsed: string[];
  sorts: Record<string, string>;
  canSync: boolean;
}

/** Per reader: which columns are folded away is not board configuration. */
const collapseKey = (slug: string, status: string) => `pp.board.${slug}.collapsed.${status}`;
/**
 * The chosen sort is persisted for the same reason collapse is — it is the reader's own view of
 * the board, not its configuration.
 *
 * It also has to survive a remount: a move refetches by remounting the columns, and holding the
 * sort in component state alone meant every move silently threw the reader back to the default.
 * That was invisible until a hand-arranged order needed to survive the move that made it.
 */
const sortKey = (slug: string, status: string) => `pp.board.${slug}.sort.${status}`;

/**
 * How a reader has arranged a board, from wherever the answer is fastest.
 *
 * `localStorage` is read synchronously and used for the first paint. A board that waits on a
 * request before it can render is a worse board for everybody, including the reader who paid for
 * the syncing.
 */
export function localCollapsed(slug: string, status: string): boolean {
  return window.localStorage.getItem(collapseKey(slug, status)) === 'true';
}

export function localSort(slug: string, status: string): string {
  return window.localStorage.getItem(sortKey(slug, status)) ?? '';
}

/**
 * Records a change locally, and on the server when the reader syncs.
 *
 * Local first and unconditionally: a failed or refused request must not lose a change the reader
 * has already seen take effect. The server copy is best-effort by design — this is column
 * arrangement, not anything that carries consequence.
 */
export async function remember(
  slug: string,
  status: string,
  change: { collapsed?: boolean; sort?: string },
): Promise<void> {
  if (change.collapsed !== undefined) {
    window.localStorage.setItem(collapseKey(slug, status), String(change.collapsed));
  }
  if (change.sort !== undefined) {
    window.localStorage.setItem(sortKey(slug, status), change.sort);
  }
  try {
    await api.put(`/creators/${encodeURIComponent(slug)}/view-settings`, wholeBoard(slug));
  } catch {
    // Refused because they do not sync, or the request failed. Either way the local copy stands
    // and the board looks exactly as they left it.
  }
}

/** The whole arrangement, because the endpoint replaces rather than patches. */
function wholeBoard(slug: string): { collapsed: string[]; sorts: Record<string, string> } {
  const columns = ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED'];
  const sorts: Record<string, string> = {};
  for (const status of columns) {
    const sort = localSort(slug, status);
    if (sort) sorts[status] = sort;
  }
  return { collapsed: columns.filter((status) => localCollapsed(slug, status)), sorts };
}

/**
 * Brings the stored arrangement down into `localStorage`, so the next paint uses it.
 *
 * The server wins when the two differ, which is the whole feature: on a new device the local copy
 * is empty and this fills it in with nothing visibly changing, and on the same device they
 * already agree. They can only disagree when the reader arranged the board elsewhere — which is
 * exactly when the stored answer is the right one.
 */
export async function hydrate(slug: string): Promise<boolean> {
  let stored: BoardSettings;
  try {
    stored = await api.get<BoardSettings>(`/creators/${encodeURIComponent(slug)}/view-settings`);
  } catch {
    return false;
  }
  if (!stored.canSync) return false;

  for (const status of ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED']) {
    window.localStorage.setItem(
      collapseKey(slug, status),
      String(stored.collapsed.includes(status)),
    );
    window.localStorage.setItem(sortKey(slug, status), stored.sorts[status] ?? '');
  }
  return true;
}
