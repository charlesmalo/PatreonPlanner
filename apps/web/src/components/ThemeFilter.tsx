import { useRef } from 'react';
import type { ThemeSummary } from '../api/types';

interface ThemeFilterProps {
  themes: ThemeSummary[];
  /** Every label currently narrowing the column. Empty means no filter. */
  selected: string[];
  onChange: (themeIds: string[]) => void;
}

/**
 * Design §7's browse-by-theme, as removable filter chips.
 *
 * **Multi-select, matched as OR.** Adding a label widens the results, which is what a chip filter
 * conventionally does — a reader adding "Thriller" to "Anime" is asking for more, not for the
 * handful of entries carrying both. The server reads it the same way.
 *
 * **No count on the label.** It used to read "Anime (3)", but that number is board-wide and this
 * control now sits inside one column, so it would claim a total the entries underneath it do not
 * add up to. A number that does not match what is on screen is worse than no number.
 *
 * Two buttons per selected chip rather than one: a remove control nested inside a toggle would be
 * a button inside a button, which is invalid and which no screen reader reads the way it looks.
 * They are siblings, each with its own name — "Anime", and "Remove Anime filter".
 */
export function ThemeFilter({ themes, selected, onChange }: ThemeFilterProps) {
  // Keyed by label id: the ✕ vanishes with the selection, so focus has to go somewhere that
  // survives the removal. The toggle for that same label does.
  const toggles = useRef(new Map<string, HTMLButtonElement | null>());

  // An empty control suggests filtering exists and does nothing.
  if (themes.length === 0) return null;

  const active = themes.filter((theme) => selected.includes(theme.id));
  const remove = (id: string) => {
    onChange(selected.filter((selectedId) => selectedId !== id));
    toggles.current.get(id)?.focus();
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
        {/* Inline with the heading, and only while there is something to clear: a permanently
            visible "Clear all" is a control that does nothing most of the time. */}
        {active.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Clear all
          </button>
        ) : null}
      </div>

      <ul className="mt-1.5 flex flex-wrap gap-2">
        {themes.map((theme) => {
          const on = selected.includes(theme.id);
          return (
            <li key={theme.id} className="relative">
              <button
                type="button"
                ref={(node) => toggles.current.set(theme.id, node)}
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? selected.filter((id) => id !== theme.id) : [...selected, theme.id])
                }
                className={`rounded-full border py-0.5 pl-2.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                  on
                    ? 'border-sky-500 bg-sky-50 pr-6 dark:bg-sky-950'
                    : 'border-slate-300 pr-2.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
                }`}
              >
                {/* Text, never markup: label names are creator-editable. */}
                {theme.name}
              </button>
              {on ? (
                <button
                  type="button"
                  // Names the label, not just "remove": a screen reader announcing eight identical
                  // "Remove" buttons has told the reader nothing about which one to press.
                  aria-label={`Remove ${theme.name} filter`}
                  onClick={() => remove(theme.id)}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full px-1 text-xs leading-none text-slate-500 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400 dark:hover:text-slate-100"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Polite, not assertive: the list below has changed, which is worth saying once the reader
          finishes what they are doing rather than interrupting them mid-word. */}
      <p role="status" aria-live="polite" className="sr-only">
        {active.length === 0
          ? 'No label filters.'
          : `Filtering by ${active.map((theme) => theme.name).join(', ')}.`}
      </p>
    </div>
  );
}
