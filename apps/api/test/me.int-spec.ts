import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('GET /api/v1/me (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function login(): Promise<string> {
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const callback = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    return pickCookie(callback, 'pp_session');
  }

  /**
   * Logout is a POST, so it carries CSRF like any other state-changing request. The token has
   * to be one this server signed for this session, so it is minted by a safe request.
   */
  async function logout(sessionCookie: string): Promise<request.Response> {
    const safe = await request(ctx.app.getHttpServer())
      .get('/healthz')
      .set('Cookie', sessionCookie)
      .expect(200);
    const csrf = pickCookie(safe, 'pp_csrf').split(';')[0];
    const token = csrf.split('=').slice(1).join('=');
    return request(ctx.app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', [sessionCookie, csrf])
      .set('x-csrf-token', token);
  }

  it('returns 401 without a session cookie', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('returns 401 for a bogus session cookie', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', 'pp_session=not-a-real-token')
      .expect(401);
  });

  it('returns the current user for a valid session', async () => {
    const cookie = await login();
    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toEqual({
      id: expect.any(String),
      patreonUserId: 'patreon-user-1',
      fullName: 'Ada Lovelace',
      avatarUrl: 'https://example.com/ada.png',
    });
  });

  it('never exposes stored patreon tokens', async () => {
    const cookie = await login();
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('access-token');
    expect(body).not.toContain('Encrypted');
    expect(body).not.toContain('v1:');
  });

  it('stops accepting the cookie after logout', async () => {
    const cookie = await login();
    expect((await logout(cookie)).status).toBe(204);
    await request(ctx.app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie).expect(401);
  });

  it('rejects a session whose user no longer exists', async () => {
    const cookie = await login();
    // A session outliving its user must not authenticate: deleting the row has to be enough
    // to lock the holder out, without hunting down their sessions.
    await ctx.prisma.user.deleteMany({ where: { patreonUserId: 'patreon-user-1' } });
    await request(ctx.app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie).expect(401);
  });
});
