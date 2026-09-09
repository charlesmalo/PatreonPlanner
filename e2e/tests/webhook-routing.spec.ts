import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CREATOR, seed, seedCreator, setPatreonIdentity } from './support';

/**
 * That a webhook can reach the API at all through the deployed origin.
 *
 * The API mounts webhooks at the **root** rather than under `/api/v1`, on purpose: the URL is
 * registered with Patreon and must not move when the API version does. The proxy in front of it
 * forwarded `/api/` and `/auth/` and not `/webhooks/`, so every delivery was answered by the SPA
 * fallback instead of the API — in the deployed stack and in the dev server alike.
 *
 * Nothing failed visibly. Deliveries were rejected by nginx, memberships arrived at the next sync
 * instead of immediately, and the settings page correctly showed a URL nothing was listening on.
 */
test.describe('webhook routing', () => {
  const body = JSON.stringify({ data: { attributes: {} } });

  test('a Patreon delivery reaches the API rather than the SPA', async ({ request }) => {
    // A real creator id is not needed: what is being tested is who answers. The API rejects an
    // unsigned delivery with 401 — nginx serving index.html answers 405, because a static file
    // cannot be POSTed to. The status alone distinguishes them, and so does the content type.
    const res = await request.post('/webhooks/patreon/00000000-0000-4000-8000-000000000000', {
      headers: { 'Content-Type': 'application/json', 'X-Patreon-Event': 'members:pledge:delete' },
      data: body,
    });

    expect(res.status()).toBe(401);
    expect(res.headers()['content-type'] ?? '').not.toContain('text/html');
  });

  test('a Resend delivery reaches the API rather than the SPA', async ({ request }) => {
    const res = await request.post('/webhooks/resend', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ type: 'email.bounced' }),
    });

    expect(res.status()).not.toBe(405);
    expect(res.headers()['content-type'] ?? '').not.toContain('text/html');
  });

  test('a correctly signed delivery is accepted through the proxy', async ({ page, request }) => {
    // Routing alone only proves who answers. The signature is an HMAC over the **raw body**, so
    // this is also the test that the proxy hands the bytes through unaltered — a rewritten
    // encoding or a re-serialised body would verify locally and fail in front of nginx.
    seedCreator();
    await setPatreonIdentity({ id: 'hook-routing-owner', fullName: 'Ada', memberships: [] });
    await page.goto('/');
    await page.getByRole('link', { name: /sign in with patreon/i }).click();
    await page.waitForURL((url) => url.pathname === '/');
    seed(
      `INSERT INTO "CreatorStaff"(id,"creatorId","userId",role,"createdAt","updatedAt")
         SELECT gen_random_uuid(),'${CREATOR.id}',u.id,'OWNER',now(),now()
         FROM "User" u WHERE u."patreonUserId"='hook-routing-owner'
         ON CONFLICT ("creatorId","userId") DO UPDATE SET role='OWNER';`,
    );

    const secret = 'through-the-proxy';
    await page.goto(`/c/${CREATOR.slug}/settings`);
    await page.getByLabel(/signing secret/i).fill(secret);
    await page.getByRole('button', { name: /save the secret/i }).click();
    await expect(page.getByText(/a secret is set/i)).toBeVisible();

    const signed = JSON.stringify({ data: { attributes: {}, relationships: {} } });
    const res = await request.post(`/webhooks/patreon/${CREATOR.id}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Patreon-Event': 'members:pledge:delete',
        'X-Patreon-Signature': createHmac('md5', secret).update(Buffer.from(signed)).digest('hex'),
      },
      data: signed,
    });

    expect(res.status()).toBe(204);
  });
});
