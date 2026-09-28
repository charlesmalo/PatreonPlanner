import { useCallback, useEffect, useState } from 'react';
import { api } from './client';

export interface TokenState {
  enabled: boolean;
  available: number;
  ledger: Array<{
    id: string;
    kind: 'TIER_GRANT' | 'CREATOR_GRANT' | 'SPEND';
    amount: number;
    periodKey: string | null;
    reason: string | null;
    createdAt: string;
  }>;
}

const NONE: TokenState = { enabled: false, available: 0, ledger: [] };

/**
 * This reader's tokens on one board.
 *
 * Reading this is also what *grants* them: the API grants any period due before answering, which
 * is the whole of the lazy-grant design — no cron, no monthly fan-out. So the board asking for a
 * balance is not merely a read, and a board that never asked would never grant.
 *
 * A failure is silence, not an error: tokens are an extra on top of a board that works without
 * them, and a reader who cannot see their balance should still get their board.
 */
export function useTokens(slug: string, enabled: boolean) {
  const [state, setState] = useState<TokenState>(NONE);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setState(await api.get<TokenState>(`/creators/${encodeURIComponent(slug)}/tokens`));
    } catch {
      setState(NONE);
    }
  }, [slug, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
