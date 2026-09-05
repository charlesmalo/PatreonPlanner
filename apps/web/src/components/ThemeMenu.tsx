import { useEffect, useRef, useState } from 'react';
import {
  type ThemeChoice,
  applyTheme,
  readStoredChoice,
  storeChoice,
  systemPrefersDark,
} from '../theme';

const OPTIONS: Array<{ value: ThemeChoice; label: string; hint: string }> = [
  { value: 'light', label: 'Light', hint: '☀' },
  { value: 'dark', label: 'Dark', hint: '☾' },
  { value: 'system', label: 'System', hint: '🖵' },
];

/**
 * Choosing a theme, from the header.
 *
 * A menu rather than a two-state switch, because there are three answers and one of them is "stop
 * asking me" — see `theme.ts` for why System has to exist rather than being implied by never
 * touching the control.
 */
export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredChoice());
  const container = useRef<HTMLDivElement>(null);

  // While the reader is following the operating system, keep following it. Without this the page
  // would only change theme on reload, which is exactly when nobody is looking.
  useEffect(() => {
    if (choice !== 'system') return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const sync = () => applyTheme('system');
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [choice]);

  // Closing on an outside click and on Escape, because a menu that can only be closed by choosing
  // something forces a choice nobody asked to make.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function pick(next: ThemeChoice) {
    setChoice(next);
    storeChoice(next);
    applyTheme(next);
    setOpen(false);
  }

  const showing = choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        // Names the current state, not just the control: "Theme" alone leaves a screen-reader
        // user pressing it to find out what it is set to.
        aria-label={`Theme: ${choice}${choice === 'system' ? ` (currently ${showing})` : ''}`}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <span aria-hidden="true">{showing === 'dark' ? '☾' : '☀'}</span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 z-20 mt-1 w-40 rounded border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900"
        >
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === option.value}
              onClick={() => pick(option.value)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
            >
              <span aria-hidden="true" className="w-4">
                {option.hint}
              </span>
              {option.label}
              {/* A tick rather than colour alone: which item is chosen must survive being read
                  aloud, and must not depend on telling two greys apart. */}
              <span aria-hidden="true" className="ml-auto">
                {choice === option.value ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
