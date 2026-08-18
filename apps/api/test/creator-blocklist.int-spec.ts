import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Creator blocklist (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let owner: Auth;
  let otherOwner: Auth;
  let mod: Auth;
  let patron: Auth;

  const originalLimits = {
    perHour: process.env.SUBMIT_LIMIT_PER_HOUR,
    global: process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL,
  };

  beforeAll(async () => {
    // Set before boot, and scoped to this suite: raising it in the shared defaults would switch
    // off the test that proves the submission cap works.
    process.env.SUBMIT_LIMIT_PER_HOUR = '1000';
    process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL = '1000';
    ctx = await startAuthApp();

    owner = await loginAs('bl-owner');
    const ownerId = await userId('bl-owner');
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bl-campaign',
          ownerUserId: ownerId,
          displayName: 'Block Co',
          slug: 'block-co',
          policy: { create: {} },
          staff: { create: { userId: ownerId, role: 'OWNER' } },
        },
      })
    ).id;

    otherOwner = await loginAs('bl-other-owner');
    const otherOwnerId = await userId('bl-other-owner');
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bl-other',
          ownerUserId: otherOwnerId,
          displayName: 'Other Co',
          slug: 'other-co',
          policy: { create: {} },
          staff: { create: { userId: otherOwnerId, role: 'OWNER' } },
        },
      })
    ).id;

    mod = await loginAs('bl-mod');
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: await userId('bl-mod'), role: 'MOD' },
    });
    patron = await loginAs('bl-patron');
    for (const [id, target] of [
      [await userId('bl-patron'), creatorId],
      [await userId('bl-patron'), otherCreatorId],
    ] as const) {
      await ctx.prisma.membership.create({
        data: { userId: id, creatorId: target, amountCents: 500, isActivePatron: true },
      });
    }
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    restore('SUBMIT_LIMIT_PER_HOUR', originalLimits.perHour);
    restore('SUBMIT_LIMIT_PER_HOUR_GLOBAL', originalLimits.global);
  });

  function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(async () => {
    await ctx.prisma.creatorBlockword.deleteMany();
    await ctx.prisma.moderationResult.deleteMany();
    await ctx.prisma.abuseRecord.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
  });

  const userId = async (patreonUserId: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } })).id;

  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const addWord = (auth: Auth, slug: string, body: object) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/blocklist`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const listWords = (auth: Auth, slug: string) =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${slug}/blocklist`)
      .set('Cookie', [auth.session, auth.csrf]);

  const removeWord = (auth: Auth, slug: string, id: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1/creators/${slug}/blocklist/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const submitTo = (auth: Auth, slug: string, customTitle: string) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/recommendations`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ type: 'EXTERNAL_LINK', customTitle, links: [{ url: 'https://example.com/a' }] });

  describe('managing the list', () => {
    it('refuses a change from a moderator', async () => {
      // Design §7 files the blocklist under creator admin, beside policy: it decides what the
      // board will accept, and a mod who arrived by invite link must not hold that.
      await addWord(mod, 'block-co', { pattern: 'anything' }).expect(403);
    });

    it('refuses a change from a patron', async () => {
      await addWord(patron, 'block-co', { pattern: 'anything' }).expect(403);
    });

    it('stores the word normalised', async () => {
      const res = await addWord(owner, 'block-co', { pattern: '  GaNoNdOrF  ' }).expect(201);

      expect(res.body).toMatchObject({ pattern: 'ganondorf', action: 'BLOCK' });
    });

    it('rejects a duplicate rather than silently keeping two', async () => {
      await addWord(owner, 'block-co', { pattern: 'ganondorf' }).expect(201);
      await addWord(owner, 'block-co', { pattern: 'GANONDORF' }).expect(409);
    });

    it('never shows one board list to another board owner', async () => {
      // Both boards have words, so an unscoped query would satisfy a test that only checked for
      // an empty list.
      await addWord(owner, 'block-co', { pattern: 'ganondorf' }).expect(201);
      await addWord(otherOwner, 'other-co', { pattern: 'zelda' }).expect(201);

      const res = await listWords(otherOwner, 'other-co').expect(200);

      expect(res.body.items.map((w: { pattern: string }) => w.pattern)).toEqual(['zelda']);
    });

    it('never deletes another board word', async () => {
      const mine = (await addWord(owner, 'block-co', { pattern: 'ganondorf' })).body;

      await removeWord(otherOwner, 'other-co', mine.id).expect(404);

      expect(await ctx.prisma.creatorBlockword.count({ where: { creatorId } })).toBe(1);
    });

    it('removes a word this board owns', async () => {
      const mine = (await addWord(owner, 'block-co', { pattern: 'ganondorf' })).body;

      await removeWord(owner, 'block-co', mine.id).expect(204);

      expect(await ctx.prisma.creatorBlockword.count({ where: { creatorId } })).toBe(0);
    });
  });

  describe('applying the list', () => {
    it('blocks a word this board added, which another board still accepts', async () => {
      await addWord(owner, 'block-co', { pattern: 'ganondorf', action: 'BLOCK' }).expect(201);
      await addWord(otherOwner, 'other-co', { pattern: 'zelda', action: 'BLOCK' }).expect(201);

      await submitTo(patron, 'block-co', 'The Ganondorf Cut').expect(400);
      await submitTo(patron, 'other-co', 'The Ganondorf Cut').expect(201);
    });

    it('matches without regard to case', async () => {
      await addWord(owner, 'block-co', { pattern: 'GANONDORF' }).expect(201);

      await submitTo(patron, 'block-co', 'the ganondorf cut').expect(400);
    });

    it('records the block against this board, naming the creator as the source', async () => {
      await addWord(owner, 'block-co', { pattern: 'ganondorf' }).expect(201);

      await submitTo(patron, 'block-co', 'The Ganondorf Cut').expect(400);

      const [row] = await ctx.prisma.moderationResult.findMany();
      expect(row).toMatchObject({
        creatorId,
        verdict: 'BLOCK',
        source: 'CREATOR',
        categories: ['CREATOR_BLOCKLIST'],
      });
    });

    it('lets a FLAG word through, and records it against the entry', async () => {
      // The verdict design §6.5 describes as "needs review": the entry is created, and the
      // record is what puts it in front of a moderator.
      await addWord(owner, 'block-co', { pattern: 'spoiler', action: 'FLAG' }).expect(201);

      await submitTo(patron, 'block-co', 'Huge spoiler discussion').expect(201);

      const entry = await ctx.prisma.recommendation.findFirstOrThrow({ where: { creatorId } });
      expect(entry.status).toBe('PENDING');
      const [row] = await ctx.prisma.moderationResult.findMany();
      expect(row).toMatchObject({
        verdict: 'FLAG',
        source: 'CREATOR',
        // Linked after the fact: the entry did not exist when the pipeline ran, and a verdict
        // the review queue cannot attach to anything is a verdict nobody acts on.
        subjectId: entry.id,
      });
    });

    it('does not earn an abuse strike for a FLAG', async () => {
      // A strike is design §6.5's answer to a BLOCK. A creator choosing the softer verdict must
      // not be quietly handing out timeouts with it.
      await addWord(owner, 'block-co', { pattern: 'spoiler', action: 'FLAG' }).expect(201);

      await submitTo(patron, 'block-co', 'Huge spoiler discussion').expect(201);

      expect(
        await ctx.prisma.abuseRecord.count({ where: { userId: await userId('bl-patron') } }),
      ).toBe(0);
    });

    it('takes the harsher verdict when both stages match', async () => {
      await addWord(owner, 'block-co', { pattern: 'ordinary', action: 'FLAG' }).expect(201);

      await submitTo(patron, 'block-co', 'an ordinary load of shit').expect(400);

      const [row] = await ctx.prisma.moderationResult.findMany();
      expect(row.verdict).toBe('BLOCK');
    });

    it('takes the block when one word flags and another blocks the same text', async () => {
      // Within the board's own list, not across stages: a creator who has flagged "spoiler" and
      // blocked "ganondorf" expects text carrying both to be refused, not quietly let through
      // because the flag happened to be found first.
      await addWord(owner, 'block-co', { pattern: 'spoiler', action: 'FLAG' }).expect(201);
      await addWord(owner, 'block-co', { pattern: 'ganondorf', action: 'BLOCK' }).expect(201);

      await submitTo(patron, 'block-co', 'A spoiler about Ganondorf').expect(400);

      const [row] = await ctx.prisma.moderationResult.findMany();
      expect(row).toMatchObject({ verdict: 'BLOCK', source: 'CREATOR' });
    });

    it('leaves an unlisted word alone', async () => {
      await addWord(owner, 'block-co', { pattern: 'ganondorf' }).expect(201);

      await submitTo(patron, 'block-co', 'An ordinary film').expect(201);

      expect(await ctx.prisma.moderationResult.count()).toBe(0);
    });
  });
});
