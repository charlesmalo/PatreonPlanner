import type { CatalogResult } from '../api/types';
import type { DraftItem } from './WatchOrderEditor';

/** A collection is a franchise; everything else the catalogue returns is a single work. */
const TYPE_FOR_MEDIA: Record<CatalogResult['mediaType'], 'MOVIE' | 'SHOW' | 'FRANCHISE'> = {
  MOVIE: 'MOVIE',
  TV: 'SHOW',
  COLLECTION: 'FRANCHISE',
};

export const MAX_ITEMS = 50;

/**
 * What the form sends, worked out without any of the form.
 *
 * Here rather than inside the component because it is the part with rules in it — which fields
 * go together, which are trimmed away when blank, what a watch order counts as valid — and none
 * of that needs a rendered form to be checked. What stays behind is state and markup.
 *
 * Every check below mirrors a bound the DTO already enforces. They exist so the common mistake
 * costs no round trip; the server's 400 is still what decides, and is still rendered when the two
 * disagree.
 */

/** Blank steps are the natural result of one "Add a step" too many; dropping them beats a 400. */
export function filledItems(items: DraftItem[]): DraftItem[] {
  return items.filter(
    (item) => item.tmdbId !== undefined || (item.customTitle ?? '').trim().length > 0,
  );
}

/** What is wrong with this watch order, in the reader's words, or null if nothing is. */
export function watchOrderProblem(customTitle: string, items: DraftItem[]): string | null {
  if (customTitle.trim().length === 0) return 'Give the watch order a name.';
  const filled = filledItems(items);
  if (filled.length === 0) return 'A watch order needs at least one step.';
  if (filled.length > MAX_ITEMS) return 'A watch order can have at most fifty steps.';
  return null;
}

export function watchOrderPayload(
  customTitle: string,
  description: string,
  items: DraftItem[],
): Record<string, unknown> {
  return {
    type: 'WATCH_ORDER',
    customTitle: customTitle.trim(),
    ...(description.trim() ? { description: description.trim() } : {}),
    // Order in the array *is* the order; the server numbers from it.
    items: filledItems(items).map((item) =>
      item.tmdbId !== undefined
        ? {
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
            ...(item.note?.trim() ? { note: item.note.trim() } : {}),
          }
        : {
            customTitle: (item.customTitle as string).trim(),
            ...(item.note?.trim() ? { note: item.note.trim() } : {}),
          },
    ),
  };
}

export function singlePayload(
  picked: CatalogResult | null,
  freeTitle: string,
  description: string,
  url: string,
): Record<string, unknown> {
  return picked
    ? {
        // The canonical name comes from the catalogue, so none is sent.
        type: TYPE_FOR_MEDIA[picked.mediaType],
        tmdbId: picked.tmdbId,
        ...(description.trim() ? { description: description.trim() } : {}),
      }
    : {
        type: 'EXTERNAL_LINK',
        customTitle: freeTitle,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(url.trim() ? { links: [{ url: url.trim() }] } : {}),
      };
}
