import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CatalogResult } from '../api/types';

export interface DraftItem {
  /** Set when the step is bound to a catalogue title; then `customTitle` must not be. */
  tmdbId?: number;
  mediaType?: 'MOVIE' | 'SHOW';
  /** Display-only, for a bound step. Never sent. */
  boundName?: string;
  customTitle?: string;
  note?: string;
}

interface WatchOrderEditorProps {
  slug: string;
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
}

export function WatchOrderEditor({ slug, items, onChange }: WatchOrderEditorProps) {
  function update(index: number, changes: Partial<DraftItem>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  }

  function move(index: number, delta: number) {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    onChange(next);
  }

  return (
    <div>
      <p className="text-sm font-medium">Steps</p>
      <ol className="mt-2 space-y-3">
        {items.map((item, index) => (
          // Index as key: steps have no identity of their own before they are saved, and the
          // server numbers them from this order anyway.
          <li key={index} className="rounded border border-slate-200 p-2 dark:border-slate-700">
            <div className="flex items-start gap-2">
              <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">{index + 1}.</span>
              <div className="flex-1 space-y-2">
                {item.tmdbId !== undefined ? (
                  // A bound step takes its name from the catalogue: the API rejects a step that
                  // carries both, so offering a title field here would build an invalid request.
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{item.boundName}</span>
                    <button
                      type="button"
                      onClick={() =>
                        update(index, {
                          tmdbId: undefined,
                          mediaType: undefined,
                          boundName: undefined,
                          customTitle: item.boundName ?? '',
                        })
                      }
                      aria-label={`Unlink step ${index + 1} from the catalogue`}
                      className="text-xs underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    >
                      Unlink
                    </button>
                  </div>
                ) : (
                  <StepTitleField
                    slug={slug}
                    index={index}
                    value={item.customTitle ?? ''}
                    onText={(customTitle) => update(index, { customTitle })}
                    onBind={(result) =>
                      update(index, {
                        tmdbId: result.tmdbId,
                        mediaType: result.mediaType === 'TV' ? 'SHOW' : 'MOVIE',
                        boundName: result.name,
                        customTitle: undefined,
                      })
                    }
                  />
                )}
                <div>
                  <label htmlFor={`step-note-${index}`} className="sr-only">
                    Step {index + 1} note
                  </label>
                  <input
                    id={`step-note-${index}`}
                    value={item.note ?? ''}
                    maxLength={500}
                    placeholder="Note (optional)"
                    onChange={(e) => update(index, { note: e.target.value })}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                {/* Absent rather than disabled at the ends: a control that cannot do anything is
                    a lie, and the server numbers steps straight from this order. */}
                {index > 0 ? (
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    aria-label={`Move step ${index + 1} up`}
                    className="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    ↑
                  </button>
                ) : null}
                {index < items.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    aria-label={`Move step ${index + 1} down`}
                    className="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    ↓
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_unused, i) => i !== index))}
                  aria-label={`Remove step ${index + 1}`}
                  className="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  ✕
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => onChange([...items, { customTitle: '' }])}
        className="mt-2 rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Add a step
      </button>
    </div>
  );
}

/**
 * Free text with catalogue suggestions underneath. Typing is always allowed — TMDB will not know
 * every fan edit — but picking a suggestion binds the step, which is what earns it a canonical
 * name and a poster on the board.
 */
function StepTitleField({
  slug,
  index,
  value,
  onText,
  onBind,
}: {
  slug: string;
  index: number;
  value: string;
  onText: (value: string) => void;
  onBind: (result: CatalogResult) => void;
}) {
  const [results, setResults] = useState<CatalogResult[]>([]);

  useEffect(() => {
    const query = value.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get<{ results: CatalogResult[] }>(
          `/creators/${encodeURIComponent(slug)}/catalog/search?q=${encodeURIComponent(query)}`,
        )
        // A step is usable without the catalogue, so a failed lookup shows no suggestions rather
        // than an error the submitter can do nothing about.
        .then((body) => !cancelled && setResults(body.results.slice(0, 5)))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, value]);

  return (
    <div>
      <label htmlFor={`step-title-${index}`} className="sr-only">
        Step {index + 1} title
      </label>
      <input
        id={`step-title-${index}`}
        value={value}
        maxLength={200}
        placeholder="What to watch"
        onChange={(e) => onText(e.target.value)}
        className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
      />
      {results.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {results.map((result) => (
            <li key={`${result.mediaType}-${result.tmdbId}`}>
              <button
                type="button"
                onClick={() => onBind(result)}
                aria-label={`Use ${result.name} for step ${index + 1}`}
                className="w-full rounded px-2 py-0.5 text-left text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
              >
                {result.name}
                {result.year ? ` (${result.year})` : ''}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
