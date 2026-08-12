import type { WatchOrderItem } from '../api/types';

/** Read-only rendering of a WATCH_ORDER's steps, in the order the server numbered them. */
export function WatchOrderList({ items }: { items: WatchOrderItem[] }) {
  if (items.length === 0) return null;

  return (
    <ol className="mt-2 space-y-1">
      {items.map((item) => (
        <li key={item.position} className="flex gap-2 text-sm">
          <span className="text-slate-500 dark:text-slate-400">{item.position + 1}.</span>
          <span className="min-w-0">
            {/* Text, never markup: both the step title and its note are submitter-controlled. */}
            <span className="break-words">{item.title?.name ?? item.customTitle}</span>
            {item.title?.year ? (
              <span className="ml-1 text-slate-500 dark:text-slate-400">({item.title.year})</span>
            ) : null}
            {item.note ? (
              <span className="block break-words text-xs text-slate-600 dark:text-slate-300">
                {item.note}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
