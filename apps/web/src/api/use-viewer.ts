import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from './client';
import {
  ACK_AFTER_MS,
  ACK_SUPPRESS_MS,
  narrowCapabilities,
  viewModeKey,
  type ViewMode,
} from './view-mode';
import type { Capabilities, CreatorProfile, SessionUser } from './types';

/** Who is reading, and what this board lets them do. */

const NO_CAPABILITIES: Capabilities = {
  view: false,
  upvote: false,
  submit: false,
  permissions: [],
  moderate: false,
  administer: false,
};

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SessionUser>('/me')
      .then((value) => {
        if (!cancelled) setUser(value);
      })
      // A 401 is the ordinary anonymous case, not a failure — rendering an error for every
      // logged-out visitor would be wrong.
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Anything that 401s means the session is gone, whoever the header currently claims to be.
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  const signOut = useCallback(async () => {
    try {
      // Root-mounted: the API excludes auth/logout from the /api/v1 prefix, so prefixing it 404s
      // and the session would survive a click that looked like it worked.
      await api.postRoot('/auth/logout');
    } finally {
      setUser(null);
      // Reload regardless: a failed logout must not leave the UI showing a signed-in header over
      // a session whose state we no longer know.
      window.location.assign('/');
    }
  }, []);

  return { user, loading, signOut };
}

/**
 * Which view the reader has chosen for this board, and whether switching back into moderator
 * view should ask first.
 *
 * Per board and local, like column collapse: a moderator on one board is a patron on another, and
 * the choice is nobody else's business.
 */
export function useViewMode(slug: string) {
  const [mode, setMode] = useState<ViewMode>('moderator');
  const [needsAck, setNeedsAck] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(viewModeKey(slug));
    setMode(stored === 'patron' ? 'patron' : 'moderator');

    const suppressedUntil = Number(
      window.localStorage.getItem(`${viewModeKey(slug)}.ackUntil`) ?? 0,
    );
    const lastSeen = Number(window.localStorage.getItem('pp.lastSeen') ?? 0);
    // Idle long enough that the reader may not remember what this tab was doing — and not inside
    // a window where they have already said not to ask.
    setNeedsAck(
      lastSeen > 0 && Date.now() - lastSeen > ACK_AFTER_MS && Date.now() > suppressedUntil,
    );
    window.localStorage.setItem('pp.lastSeen', String(Date.now()));
  }, [slug]);

  const choose = useCallback(
    (next: ViewMode, suppress?: boolean) => {
      setMode(next);
      window.localStorage.setItem(viewModeKey(slug), next);
      if (suppress) {
        window.localStorage.setItem(
          `${viewModeKey(slug)}.ackUntil`,
          String(Date.now() + ACK_SUPPRESS_MS),
        );
      }
      // Asked once per return, not once per switch.
      setNeedsAck(false);
    },
    [slug],
  );

  return { mode, needsAck, choose };
}

export function useCreator(slug: string) {
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities>(NO_CAPABILITIES);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.get<CreatorProfile>(`/creators/${encodeURIComponent(slug)}`),
      api.get<Capabilities>(`/creators/${encodeURIComponent(slug)}/capabilities`),
    ])
      .then(([profile, caps]) => {
        if (cancelled) return;
        setCreator(profile);
        setCapabilities(caps);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError(0));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { creator, capabilities, error, loading };
}
