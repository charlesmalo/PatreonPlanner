import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PatreonTokenService } from '../src/patreon/patreon-token.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('PatreonTokenService (integration)', () => {
  let ctx: AuthTestContext;
  let tokens: PatreonTokenService;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await startAuthApp();
    tokens = ctx.app.get(PatreonTokenService);
    prisma = ctx.prisma;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string): Promise<string> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const user = await prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    return user.id;
  }

  it('returns the stored token without refreshing while it is valid', async () => {
    const userId = await loginAs('token-user-1');
    ctx.patreon.refreshCalls = [];
    expect(await tokens.getAccessToken(userId)).toBe('access-token');
    expect(ctx.patreon.refreshCalls).toHaveLength(0);
  });

  it('refreshes and persists when the stored token has expired', async () => {
    const userId = await loginAs('token-user-2');
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    ctx.patreon.refreshCalls = [];

    expect(await tokens.getAccessToken(userId)).toBe('refreshed-access-token');
    expect(ctx.patreon.refreshCalls).toEqual(['refresh-token']);

    // Persisted, so the next call does not refresh again.
    ctx.patreon.refreshCalls = [];
    expect(await tokens.getAccessToken(userId)).toBe('refreshed-access-token');
    expect(ctx.patreon.refreshCalls).toHaveLength(0);
  });

  it('stores the refreshed pair encrypted', async () => {
    const userId = await loginAs('token-user-3');
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    await tokens.getAccessToken(userId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.accessTokenEncrypted).toContain('v1:');
    expect(user.accessTokenEncrypted).not.toContain('refreshed-access-token');
    expect(user.refreshTokenEncrypted).not.toContain('refreshed-refresh-token');
  });

  it('refreshes a token that is valid but within the expiry skew', async () => {
    const userId = await loginAs('token-user-4');
    // 30s left: a call made now could still arrive at Patreon after expiry.
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() + 30_000) },
    });
    ctx.patreon.refreshCalls = [];
    expect(await tokens.getAccessToken(userId)).toBe('refreshed-access-token');
    expect(ctx.patreon.refreshCalls).toHaveLength(1);
  });

  it('reports a missing token rather than throwing something opaque', async () => {
    const user = await prisma.user.create({ data: { patreonUserId: 'token-user-5' } });
    await expect(tokens.getAccessToken(user.id)).rejects.toThrow('No Patreon token');
  });

  it('propagates a refresh failure rather than returning a stale token', async () => {
    const userId = await loginAs('token-user-6');
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    ctx.patreon.refreshShouldFail = true;
    await expect(tokens.getAccessToken(userId)).rejects.toThrow('Patreon token refresh failed');
    ctx.patreon.refreshShouldFail = false;
  });
});
