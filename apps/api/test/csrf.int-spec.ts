import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('CSRF protection (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it('issues a csrf cookie on a safe request', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.join(';')).toContain('pp_csrf=');
  });

  it('issues a csrf cookie the SPA can read', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('pp_csrf='),
    ) as string;
    // Deliberately readable by JS: the SPA has to echo it back in a header. Protection comes
    // from same-origin policy stopping another site reading it, not from secrecy.
    expect(cookie).not.toContain('HttpOnly');
  });

  it('rejects a state-changing request with no csrf token', async () => {
    await request(ctx.app.getHttpServer()).post('/api/v1/anything').expect(403);
  });

  it('rejects a state-changing request whose header does not match the cookie', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', 'pp_csrf=aaa')
      .set('x-csrf-token', 'bbb')
      .expect(403);
  });

  it('rejects a state-changing request carrying only the cookie', async () => {
    // The cookie rides along automatically on a cross-site form post; the header is the part
    // an attacker cannot set, so the cookie alone must never suffice.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', 'pp_csrf=matching-token')
      .expect(403);
  });

  it('allows a state-changing request whose header matches the cookie', async () => {
    // 404 rather than 403: CSRF passed and routing took over, which is the assertion.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/anything')
      .set('Cookie', 'pp_csrf=matching-token')
      .set('x-csrf-token', 'matching-token')
      .expect(404);
  });

  it('leaves the oauth callback reachable', async () => {
    // The callback is a GET, so CSRF must not interfere with it; 401 means it reached the
    // handler and failed state validation rather than being blocked as unsafe.
    await request(ctx.app.getHttpServer())
      .get('/auth/patreon/callback?code=x&state=forged')
      .expect(401);
  });
});
