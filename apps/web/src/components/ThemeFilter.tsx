import type { ThemeSummary } from '../api/types';

interface ThemeFilterProps {
  themes: ThemeSummary[];
  selected: string | null;
  onSelect: (themeId: string | null) => void;
}

/** Design §7's browse-by-theme. A toggle, not a dropdown: one theme at a time, cleared by re-click. */
export function ThemeFilter({ themes, selected, onSelect }: ThemeFilterProps) {
  // An empty control suggests filtering exists and does nothing.
  if (themes.length === 0) return null;

  return (
    <div className="mt-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Themes
      </h2>
      <ul className="mt-1 flex flex-wrap gap-2">
        {themes.map((theme) => {
          const active = theme.id === selected;
          return (
            <li key={theme.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(active ? null : theme.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                  active
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950'
                    : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
                }`}
              >
                {/* Text, never markup: theme names are creator-editable. */}
                {theme.name} ({theme.titleCount})
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
