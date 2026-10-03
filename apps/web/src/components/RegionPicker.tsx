import { useId } from 'react';

/** Country names rather than codes, from the platform. "DE" is not what a reader calls Germany. */
function nameFor(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    // Not every runtime has the region data. The code is a worse label, not a broken one.
    return code;
  }
}

interface RegionPickerProps {
  /** The reader's choice, or null when they have not made one and the server's default applies. */
  region: string | null;
  regions: string[];
  fallback: string | null;
  onChange: (region: string) => void;
}

/**
 * Where the reader watches from, which decides what "where to watch" can honestly say.
 *
 * Absent entirely when the deployment serves one region or none: a control whose only choice is
 * the one already in effect asks the reader to make a decision that does not exist.
 */
export function RegionPicker({ region, regions, fallback, onChange }: RegionPickerProps) {
  const id = useId();
  if (regions.length < 2) return null;

  return (
    <div className="mt-3 flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-slate-600 dark:text-slate-300">
        Where to watch
      </label>
      <select
        id={id}
        value={region ?? fallback ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
      >
        {regions.map((code) => (
          <option key={code} value={code}>
            {nameFor(code)}
          </option>
        ))}
      </select>
    </div>
  );
}
