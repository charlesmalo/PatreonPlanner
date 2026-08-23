import type { ViewMode } from '../api/view-mode';

/**
 * Says which view the reader is in, in words.
 *
 * Text rather than a tint alone: a colourblind moderator gets nothing from colour, and this is
 * the signal meant to stop a mistaken edit. Nothing at all in moderator view — that is the normal
 * state for staff, and a banner that is always there stops being read.
 */
export function ModeBanner({ mode }: { mode: ViewMode }) {
  if (mode === 'moderator') return null;
  return (
    <p
      role="status"
      className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      Viewing as a <strong>patron</strong>. Moderator controls are hidden.
    </p>
  );
}
