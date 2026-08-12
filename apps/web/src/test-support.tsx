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
    hasUpvoted: false,
    title: null,
    createdAt: new Date().toISOString(),
    availability: null,
    watchOrderItems: [],
    links: [],
    submittedBy: { id: 'user-1', fullName: 'Grace', avatarUrl: null },
    ...overrides,
  };
}

/**
 * Routes fetches by method and exact pathname. Substring matching let `/recommendations` also
 * match `/recommendations/:id/upvote`, so a test could silently receive the wrong payload —
 * which is how the upvote path went untested without anyone noticing.
 */
export function fakeApi(routes: Record<string, unknown | (() => unknown)>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
    if (!(key in routes)) {
      throw new Error(`No fake route for ${key}. Known: ${Object.keys(routes).join(', ')}`);
    }
    const value = routes[key];
    const resolved = typeof value === 'function' ? (value as () => unknown)() : value;
    if (resolved instanceof Error) {
      return { ok: false, status: Number(resolved.message) || 500 } as Response;
    }
    return { ok: true, status: 200, json: async () => resolved } as Response;
  });
}
