import { useId, useState } from 'react';
import type { ViewMode } from '../api/view-mode';

interface ViewModeSwitchProps {
  mode: ViewMode;
  /** `suppress` is set when the reader asked not to be prompted again. */
  onChange: (mode: ViewMode, suppress?: boolean) => void;
  /** Whether switching *into* moderator view should ask first. */
  needsAck: boolean;
}

/**
 * Which of the two the reader is looking at.
 *
 * Switching *out* of moderator view asks nothing: giving up powers cannot go wrong. Switching
 * *in* after a long idle does — a tab left open overnight and picked up is how a change gets
 * made by accident, and design settled on an acknowledgement rather than a login prompt, which
 * would only teach people to click through auth.
 */
export function ViewModeSwitch({ mode, onChange, needsAck }: ViewModeSwitchProps) {
  const [pending, setPending] = useState(false);
  const [suppress, setSuppress] = useState(false);
  const id = useId();

  function choose(next: ViewMode) {
    if (next === 'moderator' && needsAck) {
      setPending(true);
      return;
    }
    onChange(next);
  }

  return (
    <span className="relative flex items-center gap-1.5">
      <label htmlFor={id} className="text-xs text-slate-500 dark:text-slate-400">
        Viewing as
      </label>
      <select
        id={id}
        value={mode}
        onChange={(event) => choose(event.target.value as ViewMode)}
        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
      >
        <option value="moderator">Moderator</option>
        <option value="patron">Patron</option>
      </select>

      {pending ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Switch to moderator view"
          className="absolute right-0 top-full z-20 mt-2 w-72 rounded border border-slate-300 bg-white p-3 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <p>
            This tab has been idle. Switching to <strong>moderator</strong> view puts controls back
            that change what everyone sees.
          </p>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(event) => setSuppress(event.target.checked)}
            />
            Do not ask again for 24 hours
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setPending(false);
                onChange('moderator', suppress);
              }}
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Continue as moderator
            </button>
            <button
              type="button"
              onClick={() => setPending(false)}
              className="rounded px-2 py-1 text-xs underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
