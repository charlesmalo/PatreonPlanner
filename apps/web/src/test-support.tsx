import type { Capabilities, CreatorProfile, Recommendation } from './api/types';

export const creator: CreatorProfile = {
  id: 'creator-1',
  slug: 'ada-writes',
  displayName: 'Ada Writes',
  baseUrl: null,
  tiers: [],
};

export const allCapabilities: Capabilities = {
  view: true,
  upvote: true,
  submit: true,
  moderate: false,
};

export const viewOnly: Capabilities = {
  view: true,
  upvote: false,
  submit: false,
  moderate: false,
};

export function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    type: 'EXTERNAL_LINK',
    customTitle: 'Spirited Away',
    description: 'A classic.',
    status: 'PENDING',
    upvoteCount: 3,
    createdAt: new Date().toISOString(),
    links: [],
    submittedBy: { id: 'user-1', fullName: 'Grace', avatarUrl: null },
    ...overrides,
  };
}

/** Routes fetches by URL so a test states what the server says, not how it is called. */
export function fakeApi(routes: Record<string, unknown | (() => unknown)>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (!key) throw new Error(`No fake route for ${url} (${init?.method ?? 'GET'})`);
    const value = routes[key];
    const resolved = typeof value === 'function' ? (value as () => unknown)() : value;
    if (resolved instanceof Error) {
      const status = Number(resolved.message) || 500;
      return { ok: false, status } as Response;
    }
    return { ok: true, status: 200, json: async () => resolved } as Response;
  });
}
