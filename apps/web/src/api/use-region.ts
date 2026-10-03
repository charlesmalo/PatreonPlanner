import { useCallback, useEffect, useState } from 'react';
import { api } from './client';

/** Per reader, and not per board: where somebody lives is not a property of whose board it is. */
const KEY = 'pp.availability.region';

function stored(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    // Private windows and blocked site data throw on read. A reader who cannot store a
    // preference should still get the server's default, not a crash.
    return null;
  }
}

/**
 * Which country's streaming offers this reader wants to see.
 *
 * Availability used to be answered for one region server-wide, so a patron in France read
 * "Where to watch (US)" and a list of American offers — an answer that was not merely unhelpful
 * but wrong.
 *
 * The allowed set comes from the server rather than a constant here. It is deployment
 * configuration (`AVAILABILITY_REGIONS`), bounded on purpose because an open set would let one
 * caller create a permanent refresh obligation for every country on earth — and a copy in the
 * client drifts the moment an operator edits it, leaving a reader able to pick a country the
 * server refuses.
 */
export function useRegion() {
  const [regions, setRegions] = useState<string[]>([]);
  const [fallback, setFallback] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => stored());

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ regions: string[]; default: string }>('/meta/regions')
      .then((body) => {
        if (cancelled) return;
        setRegions(Array.isArray(body?.regions) ? body.regions : []);
        setFallback(typeof body?.default === 'string' ? body.default : null);
      })
      // Silence, not an error: availability is garnish on a board that works without it, and a
      // reader who cannot reach this still gets the server's own default on every card.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const setRegion = useCallback((next: string) => {
    setChosen(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Unstorable is not unusable: the choice still applies for this visit.
    }
  }, []);

  /**
   * A stored choice the server no longer serves is dropped rather than sent. An operator can
   * shorten `AVAILABILITY_REGIONS` at any time, and a reader who picked a country that has since
   * gone would otherwise send it on every board read and get a 400 — a board that worked
   * yesterday and is broken today, for a setting they cannot see.
   */
  const region = chosen && regions.includes(chosen) ? chosen : null;

  return { region, regions, setRegion, fallback };
}
