/**
 * What a dragged card carries.
 *
 * Native HTML5 drag events, deliberately: a drag-and-drop library is a new dependency and real
 * bundle weight for a convenience layer over a control that already works. The cost is that this
 * does nothing on touch — which is why the status menu on every card is not going anywhere.
 */
export const DRAG_TYPE = 'application/x-pp-entry';

export interface DraggedEntry {
  id: string;
  status: string;
}

export function readDrag(transfer: DataTransfer | null): DraggedEntry | null {
  try {
    const raw = transfer?.getData(DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraggedEntry;
    return parsed.id ? parsed : null;
  } catch {
    // Something else was dropped on the board — a file, a link, a selection. Not ours.
    return null;
  }
}
