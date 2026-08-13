export class ApiError extends Error {
  /**
   * When the caller may retry, for the one case where the status alone cannot say enough: a
   * timed-out user needs to know *when*, and no status code carries a time. The rest of the
   * body stays unread — design §9 wants generic messages.
   */
  retryAt?: string;

  constructor(
    readonly status: number,
    retryAt?: string,
  ) {
    // The server's body is deliberately not surfaced: design §9 wants generic messages, and the
    // status is the only part the UI branches on.
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
    this.retryAt = retryAt;
  }
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
    // Only `retryAt`, and only on a 403: everything else about the body is deliberately ignored.
    let retryAt: string | undefined;
    if (response.status === 403) {
      try {
        const body = (await response.json()) as { retryAt?: unknown };
        if (typeof body?.retryAt === 'string') retryAt = body.retryAt;
      } catch {
        // A 403 with no JSON body is the ordinary "not allowed" case.
      }
    }
    throw new ApiError(response.status, retryAt);
  }
  // 204 has no body; calling json() on it throws.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** For the root-mounted auth routes, which sit outside the versioned prefix. */
  postRoot: <T>(path: string, body?: unknown) => request<T>('POST', path, body, { rootPath: true }),
};
