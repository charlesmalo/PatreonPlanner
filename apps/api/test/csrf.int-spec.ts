import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/** Extracts the bare cookie value (`name=value; Path=/...` → `value`). */
function valueOf(setCookie: string): string {
  return setCookie.split(';')[0].split('=').slice(1).join('=');
}

describe('CSRF protection (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  /** A safe request mints a token bound to whatever session the caller currently holds. */
  async function freshToken(sessionCookie?: string): Promise<string> {
    const req = request(ctx.app.getHttpServer()).get('/healthz');
    if (sessionCookie) req.set('Cookie', sessionCookie);
    const res = await req.expect(200);
    return valueOf(pickCookie(res, 'pp_csrf'));
  }

  async function login(): Promise<string> {
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const callback = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    return pickCookie(callback, 'pp_session');
  }

  it('issues a csrf cookie on a safe request', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
    expect(pickCookie(res, 'pp_csrf')).toContain('pp_csrf=');
  });

  it('issues a csrf cookie the SPA can read', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
    // Deliberately readable by JS: the SPA has to echo it back in a header. Protection comes
    // from same-origin policy stopping another site reading it, not from secrecy.
    expect(pickCookie(res, 'pp_csrf')).not.toContain('HttpOnly');
  });

  it('rejects a state-changing request with no csrf token', async () => {
    await request(ctx.app.getHttpServer()).post('/api/v1/anything').expect(403);
  });

  it('rejects a state-changing request whose header does not match the cookie', async () => {
    const token = await freshToken();
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', `pp_csrf=${token}`)
      .set('x-csrf-token', 'something-else')
      .expect(403);
  });

  it('rejects a state-changing request carrying only the cookie', async () => {
    const token = await freshToken();
    // The cookie rides along automatically on a cross-site form post; the header is the part an
    // attacker cannot set, so the cookie alone must never suffice.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', `pp_csrf=${token}`)
      .expect(403);
  });

  it('allows a state-changing request whose header matches the cookie', async () => {
    const token = await freshToken();
    // 404 rather than 403: CSRF passed and routing took over, which is the assertion.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', `pp_csrf=${token}`)
      .set('x-csrf-token', token)
      .expect(404);
  });

  it('rejects an attacker-chosen token that was never signed by this server', async () => {
    // The core weakness of unbound double-submit: anything able to plant a cookie for the
    // domain could otherwise satisfy both halves with a value it chose itself.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', 'pp_csrf=attacker-chosen-value')
      .set('x-csrf-token', 'attacker-chosen-value')
      .expect(403);
  });

  it('rejects a token whose signature has been tampered with', async () => {
    const token = await freshToken();
    const [random] = token.split('.');
    const forged = `${random}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', `pp_csrf=${forged}`)
      .set('x-csrf-token', forged)
      .expect(403);
  });

  it('rejects an anonymous token once the caller holds a session', async () => {
    const anonymous = await freshToken();
    const session = await login();
    // Bound to the session, so a token minted before login cannot be carried across it.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', [session, `pp_csrf=${anonymous}`])
      .set('x-csrf-token', anonymous)
      .expect(403);
  });

  it('accepts a token minted for the session that presents it', async () => {
    const session = await login();
    const token = await freshToken(session);
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', [session, `pp_csrf=${token}`])
      .set('x-csrf-token', token)
      .expect(404);
  });

  it('rejects a token bound to a different session', async () => {
    const sessionA = await login();
    const sessionB = await login();
    const tokenForA = await freshToken(sessionA);
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', [sessionB, `pp_csrf=${tokenForA}`])
      .set('x-csrf-token', tokenForA)
      .expect(403);
  });

  it('issues a session-bound csrf cookie as part of login', async () => {
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);

    const session = pickCookie(res, 'pp_session');
    const token = valueOf(pickCookie(res, 'pp_csrf'));
    // Without this the first write after login would 403 until a safe request re-minted one.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', [session, `pp_csrf=${token}`])
      .set('x-csrf-token', token)
      .expect(404);
  });

  it('leaves the oauth callback reachable', async () => {
    // The callback is a GET, so CSRF must not interfere; 401 means it reached the handler and
    // failed state validation rather than being blocked as unsafe.
    await request(ctx.app.getHttpServer())
      .get('/auth/patreon/callback?code=x&state=forged')
      .expect(401);
  });
});
