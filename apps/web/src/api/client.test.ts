import { ApiError, api, readCsrfToken } from './client';

describe('api client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    document.cookie = 'pp_csrf=tok-123; path=/';
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const respond = (init: Partial<Response> & { json?: () => Promise<unknown> }) =>
    vi.fn().mockResolvedValue({ ok: true, status: 200, ...init } as unknown as Response);

  it('reads the csrf token from the cookie', () => {
    expect(readCsrfToken()).toBe('tok-123');
  });

  it('calls the versioned path and returns parsed json', async () => {
    const fetchMock = respond({ json: async () => ({ ok: 1 }) });
    global.fetch = fetchMock;
    expect(await api.get('/me')).toEqual({ ok: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me');
  });

  it('sends the csrf header and the session cookie on writes', async () => {
    const fetchMock = respond({ json: async () => ({}) });
    global.fetch = fetchMock;
    await api.post('/thing', { a: 1 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok-123');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('does not send a csrf header on reads', async () => {
    const fetchMock = respond({ json: async () => ({}) });
    global.fetch = fetchMock;
    await api.get('/me');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('throws ApiError carrying the status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401 });
    await expect(api.get('/me')).rejects.toBeInstanceOf(ApiError);
  });

  it('throws rather than failing to parse a non-json error body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(api.get('/me')).rejects.toMatchObject({ status: 500 });
  });

  it('resolves a 204 without parsing a body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('should not be called');
      },
    } as unknown as Response);
    await expect(api.post('/auth/logout')).resolves.toBeUndefined();
  });
});
