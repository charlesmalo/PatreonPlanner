export class ApiError extends Error {
  /**
   * When the caller may retry, for the one case where the status alone cannot say enough: a
   * timed-out user needs to know *when*, and no status code carries a time. The rest of the
   * body stays unread — design §9 wants generic messages.
   */
  retryAt?: string;

  /**
   * Which of an endpoint's conflicts this is, for the one case where the status alone cannot say
   * enough: `POST /recommendations/:id/status` answers 409 both for an illegal transition and
   * for a move lost to another moderator, and those need **opposite** remedies — pick a different
   * move, versus reload because somebody already moved it. A client that cannot tell them apart
   * has to guess, and guessing sent moderators looking for the wrong problem.
   *
   * A short machine-readable code, never the server's prose: design §9's rule is about not
   * enumerating users and not leaking internals, and a code the client turns into its own wording
   * does neither.
   */
  conflict?: string;

  constructor(
    readonly status: number,
    extra: { retryAt?: string; conflict?: string } = {},
  ) {
    // The server's body is otherwise deliberately not surfaced: design §9 wants generic messages,
    // and the status is the only other part the UI branches on.
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
    this.retryAt = extra.retryAt;
    this.conflict = extra.conflict;
  }
}

/**
 * Notified whenever the API says the caller is not signed in.
 *
 * The session is fetched once at mount, so without this the app never learns that it ended —
 * an expired or revoked session, a sign-out in another tab, or a server that lost its session
 * store all left the header showing a name while every write failed telling the reader to sign
 * in, recoverable only by reloading the page by hand.
 */
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Readable by script on purpose — the API expects it echoed back in a header. */
export function readCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)pp_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  /**
   * Skip the /api/v1 prefix. The OAuth and logout routes are mounted at the root — they are
   * excluded from the API's global prefix because their URLs are registered with Patreon — so
   * prefixing them yields a 404.
   */
  rootPath?: boolean;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const token = readCsrfToken();
  const response = await fetch(options.rootPath ? path : `/api/v1${path}`, {
    method,
    // Same-origin by deployment (docs/decisions/2026-08-08-same-origin-deployment.md), so the
    // session cookie rides along without CORS credentials mode.
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token && method !== 'GET' ? { 'x-csrf-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    // Only a 401. A 403 is "not allowed" — a rate limit, a capability the reader lacks — and
    // treating that as a lost session would sign people out for hitting a limiter.
    if (response.status === 401) {
      for (const listener of unauthorizedListeners) listener();
    }
    // Two named fields, each on one status; everything else about the body stays ignored.
    let retryAt: string | undefined;
    let conflict: string | undefined;
    if (response.status === 403 || response.status === 409) {
      try {
        const body = (await response.json()) as { retryAt?: unknown; reason?: unknown };
        if (response.status === 403 && typeof body?.retryAt === 'string') retryAt = body.retryAt;
        // Absent on purpose for the ordinary conflict: a bare 409 still means what it always
        // meant, so every existing handler keeps working untouched.
        if (response.status === 409 && typeof body?.reason === 'string') conflict = body.reason;
      } catch {
        // A 403 or 409 with no JSON body is the ordinary "not allowed" / "conflict" case.
      }
    }
    throw new ApiError(response.status, { retryAt, conflict });
  }
  // 204 has no body; calling json() on it throws.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  /** Replaces a resource outright. The API already speaks it; the client had not needed it. */
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** For the root-mounted auth routes, which sit outside the versioned prefix. */
  postRoot: <T>(path: string, body?: unknown) => request<T>('POST', path, body, { rootPath: true }),
};
