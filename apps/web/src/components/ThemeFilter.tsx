import { useRef } from 'react';
import type { ThemeSummary } from '../api/types';
import { removeGroup, splitAt, toggleLabel } from './label-groups';

interface ThemeFilterProps {
  themes: ThemeSummary[];
  /** An OR of groups, each an AND of labels. Empty means no filter. */
  selected: string[][];
  onChange: (groups: string[][]) => void;
}

/**
 * Design §7's browse-by-theme, as removable filter chips that can be combined.
 *
 * **Groups are ANDed, and ORed with each other.** A lone chip is a group of one, so an ungrouped
 * filter behaves exactly as it did before groups existed.
 *
 * **No count on the label.** It used to read "Anime (3)", but that number is board-wide and this
 * control sits inside one column, so it would claim a total the entries underneath it do not add
 * up to.
 *
 * Every control here destroys the element that was clicked — a magnet splits the group it sits
 * in, a remove button takes its own chip away — so focus is placed deliberately. Left alone it
 * falls to `<body>`, which drops a keyboard reader at the top of the document.
 */
export function ThemeFilter({ themes, selected, onChange }: ThemeFilterProps) {
  // Keyed by label id, and by group, because the thing that was clicked is gone by the next
  // render and focus has to land somewhere that survives.
  const toggles = useRef(new Map<string, HTMLButtonElement | null>());
  const groupRemoves = useRef(new Map<string, HTMLButtonElement | null>());

  if (themes.length === 0) return null;

  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const inFilter = new Set(selected.flat());
  const spoken = selected.map((group) => group.map(nameOf).join(' and '));

  const afterSplit = (groupIndex: number, magnetIndex: number) => {
    const next = splitAt(selected, groupIndex, magnetIndex);
    onChange(next);
    // The left-hand half of what was split: the reader's attention was on that boundary.
    queueMicrotask(() => groupRemoves.current.get(next[groupIndex]?.join('|') ?? '')?.focus());
  };

  const afterRemoveGroup = (groupIndex: number) => {
    const first = selected[groupIndex][0];
    onChange(removeGroup(selected, groupIndex));
    queueMicrotask(() => toggles.current.get(first)?.focus());
  };

  return (
    <div
      role="group"
      aria-label="Filter labels"
      className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Filter labels
        </h3>
        {/* Only while there is something to clear: a permanently visible "Clear all" is a control
            that does nothing most of the time. */}
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Clear all
          </button>
        ) : null}
      </div>

      {selected.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-2">
          {selected.map((group, groupIndex) => {
            const names = group.map(nameOf);
            return (
              <li
                key={group.join('|')}
                className="flex items-center rounded-full border border-sky-500 bg-sky-50 py-0.5 pl-2.5 pr-1 text-xs dark:bg-sky-950"
              >
                {group.map((id, memberIndex) => (
                  <span key={id} className="flex items-center">
                    {/* Text, never markup: label names are creator-editable. */}
                    {names[memberIndex]}
                    {memberIndex < group.length - 1 ? (
                      <button
                        type="button"
                        // Named for what it does and to which pair: "magnet" read aloud says nothing.
                        aria-label={`Split between ${names[memberIndex]} and ${names[memberIndex + 1]}`}
                        onClick={() => afterSplit(groupIndex, memberIndex)}
                        className="mx-1 rounded-full px-1 leading-none text-sky-700 hover:bg-sky-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300 dark:hover:bg-sky-900"
                      >
                        <span aria-hidden="true">●</span>
                      </button>
                    ) : null}
                  </span>
                ))}
                <button
                  type="button"
                  ref={(node) => groupRemoves.current.set(group.join('|'), node)}
                  aria-label={`Remove ${names.join(' and ')} filter`}
                  onClick={() => afterRemoveGroup(groupIndex)}
                  className="ml-1 rounded-full px-1 leading-none text-slate-500 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400 dark:hover:text-slate-100"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ul className="mt-1.5 flex flex-wrap gap-2">
        {themes.map((theme) => (
          <li key={theme.id}>
            <button
              type="button"
              ref={(node) => toggles.current.set(theme.id, node)}
              aria-pressed={inFilter.has(theme.id)}
              onClick={() => onChange(toggleLabel(selected, theme.id))}
              className={`rounded-full border px-2.5 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                inFilter.has(theme.id)
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-950'
                  : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
              }`}
            >
              {theme.name}
            </button>
          </li>
        ))}
      </ul>

      {/* Polite, not assertive: the list below has changed, which is worth saying once the reader
          finishes what they are doing rather than interrupting them mid-word. */}
      <p role="status" aria-live="polite" className="sr-only">
        {spoken.length === 0 ? 'No label filters.' : `Filtering by ${spoken.join(', or ')}.`}
      </p>
    </div>
  );
}
