import request from 'supertest';
import { canonicalUrl } from '../src/recommendations/links.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Link candidates (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let editor: Auth;
  let bystander: Auth;
  let patron: Auth;
  let otherPatron: Auth;

  const originalLimits = {
    perHour: process.env.SUBMIT_LIMIT_PER_HOUR,
    global: process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL,
  };

  beforeAll(async () => {
    // Set before boot: config is validated once at startup, so setting this per-test does
    // nothing. Scoped to this suite and restored below, so the test proving the cap works keeps
    // working.
    process.env.SUBMIT_LIMIT_PER_HOUR = '1000';
    process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL = '1000';
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'lk-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'lk-campaign',
          ownerUserId: owner.id,
          displayName: 'Link Co',
          slug: 'link-co',
          policy: { create: {} },
          staff: { create: { userId: owner.id, role: 'OWNER' } },
        },
      })
    ).id;
    editor = await loginAs('lk-editor');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('lk-editor'),
        role: 'MOD',
        permissions: ['EDIT_ENTRIES'],
      },
    });
    bystander = await loginAs('lk-bystander');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('lk-bystander'),
        role: 'MOD',
        permissions: ['WRITE_NOTES'],
      },
    });
    patron = await loginAs('lk-patron');
    otherPatron = await loginAs('lk-other');
    for (const who of ['lk-patron', 'lk-other', 'lk-editor']) {
      await ctx.prisma.membership.create({
        data: { userId: await userId(who), creatorId, amountCents: 500, isActivePatron: true },
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
    await ctx.prisma.recommendationLink.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.abuseRecord.deleteMany();
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

  const submit = (auth: Auth, customTitle: string, url?: string) =>
    request(ctx.app.getHttpServer())
      .post('/api/v1/creators/link-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({
        type: 'EXTERNAL_LINK',
        customTitle,
        ...(url ? { links: [{ url }] } : {}),
      });

  const board = (auth?: Auth) => {
    const req = request(ctx.app.getHttpServer()).get('/api/v1/creators/link-co/recommendations');
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const decide = (auth: Auth, id: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/link-co/links/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const discard = (auth: Auth, id: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1/creators/link-co/links/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const linksOn = (id: string) =>
    ctx.prisma.recommendationLink.findMany({
      where: { recommendationId: id },
      orderBy: { createdAt: 'asc' },
    });

  describe('canonicalUrl', () => {
    it('treats the same Netflix title on two domains as one page', () => {
      // The numeric id is the identity; the TLD is which country's catalogue it was found in.
      expect(canonicalUrl('https://www.netflix.com/title/70298930')).toBe(
        canonicalUrl('https://www.netflix.ca/gb/title/70298930'),
      );
    });

    it('treats the same YouTube video written two ways as one page', () => {
      expect(canonicalUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
        canonicalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'),
      );
    });

    it('treats the same Crunchyroll series across regions as one page', () => {
      expect(canonicalUrl('https://www.crunchyroll.com/series/GY5P48XEY/re-zero')).toBe(
        canonicalUrl('https://www.crunchyroll.com/fr/series/GY5P48XEY'),
      );
    });

    it('keeps two different pages on the same platform apart', () => {
      expect(canonicalUrl('https://www.netflix.com/title/70298930')).not.toBe(
        canonicalUrl('https://www.netflix.com/title/80057281'),
      );
    });

    it('leaves an unknown domain as it found it, rather than guessing', () => {
      // Guessing at a shape we do not know would silently merge two different pages.
      const a = 'https://example.test/watch/1?ref=x';
      expect(canonicalUrl(a)).toContain('example.test');
      expect(canonicalUrl(a)).not.toBe(canonicalUrl('https://example.test/watch/2?ref=x'));
    });
  });

  describe('submitting', () => {
    it('holds a patron link as a candidate rather than publishing it', async () => {
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);

      const links = await linksOn(res.body.recommendation.id);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ status: 'CANDIDATE' });
    });

    it('publishes a staff link immediately', async () => {
      // Someone who can already edit the board's content does not approve their own URL.
      const res = await submit(editor, 'Ponyo', 'https://example.test/ponyo').expect(201);

      expect((await linksOn(res.body.recommendation.id))[0]).toMatchObject({ status: 'PUBLISHED' });
    });

    it('keeps a candidate off the board for everyone but its submitter', async () => {
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);

      const entry = (await board(otherPatron).expect(200)).body.items.find(
        (i: { id: string }) => i.id === res.body.recommendation.id,
      );
      expect(entry.links).toEqual([]);
      // Not merely hidden from the rendered list — never sent. A candidate that reaches another
      // patron's client has already escaped, whatever the client does with it.
      expect(entry.candidateLinks ?? []).toEqual([]);
    });

    it('shows submitters their own candidate, so it does not look swallowed', async () => {
      // Their own claim is not an endorsement — it is the thing they just typed. Hiding it makes
      // a submitted link look like it was dropped, and the next thing they do is submit it again.
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);

      const entry = (await board(patron).expect(200)).body.items.find(
        (i: { id: string }) => i.id === res.body.recommendation.id,
      );
      expect(entry.links).toEqual([]);
      expect(entry.candidateLinks).toEqual([
        expect.objectContaining({ url: 'https://example.test/akira' }),
      ]);
    });

    it('never hands a signed-out reader a candidate nobody submitted', async () => {
      // `submittedByUserId` is nullable and a signed-out viewer's id is null, so the obvious
      // "or you submitted it" clause compares null to null and matches every orphaned candidate
      // on the board. This is the test that fails when that guard is dropped.
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);
      await ctx.prisma.recommendationLink.updateMany({
        where: { recommendationId: res.body.recommendation.id },
        data: { submittedByUserId: null },
      });

      const entry = (await board().expect(200)).body.items.find(
        (i: { id: string }) => i.id === res.body.recommendation.id,
      );
      expect(entry.candidateLinks ?? []).toEqual([]);
    });

    it('shows a candidate to staff, who are the ones who decide', async () => {
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);

      const entry = (await board(editor).expect(200)).body.items.find(
        (i: { id: string }) => i.id === res.body.recommendation.id,
      );
      expect(entry.candidateLinks).toEqual([
        expect.objectContaining({ url: 'https://example.test/akira' }),
      ]);
      // And not among the published ones. Staff see both, kept apart — a candidate rendered as a
      // link is the endorsement this whole mechanism exists to withhold.
      expect(entry.links).toEqual([]);
    });

    it('keeps the link when the submission turns out to be a duplicate', async () => {
      // The whole point: the link is the new information in a repeat submission, and throwing it
      // away is what this replaces.
      const first = await submit(patron, 'Akira', 'https://example.test/one').expect(201);

      const again = await submit(otherPatron, 'Akira', 'https://example.test/two').expect(200);

      expect(again.body.duplicate).toBe(true);
      const links = await linksOn(first.body.recommendation.id);
      expect(links.map((l) => l.url).sort()).toEqual([
        'https://example.test/one',
        'https://example.test/two',
      ]);
      // And the response says so. The duplicate path selects its row *before* contributing, so
      // returning that row unchanged tells the submitter their link went nowhere — which is the
      // thing that makes them submit it again.
      expect(again.body.recommendation.candidateLinks).toEqual([
        expect.objectContaining({ url: 'https://example.test/two' }),
      ]);
    });

    it('tells a fresh submitter their link is waiting rather than published', async () => {
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);

      expect(res.body.recommendation.links).toEqual([]);
      expect(res.body.recommendation.candidateLinks).toEqual([
        expect.objectContaining({ url: 'https://example.test/akira' }),
      ]);
    });

    it('counts the same page submitted twice as one candidate', async () => {
      const first = await submit(patron, 'Akira', 'https://www.youtube.com/watch?v=abc123').expect(
        201,
      );

      await submit(otherPatron, 'Akira', 'https://youtu.be/abc123').expect(200);

      expect(await linksOn(first.body.recommendation.id)).toHaveLength(1);
    });

    it('stops taking candidates once a preferred link is locked in', async () => {
      const first = await submit(patron, 'Akira', 'https://example.test/one').expect(201);
      const link = (await linksOn(first.body.recommendation.id))[0];
      await decide(editor, link.id, { isPreferred: true }).expect(200);

      await submit(otherPatron, 'Akira', 'https://example.test/two').expect(200);

      // A creator who has decided where to watch something does not want a queue of
      // alternatives waiting for them.
      expect(await linksOn(first.body.recommendation.id)).toHaveLength(1);
    });
  });

  describe('deciding', () => {
    const candidate = async () => {
      const res = await submit(patron, 'Akira', 'https://example.test/akira').expect(201);
      const link = (await linksOn(res.body.recommendation.id))[0];
      return { entryId: res.body.recommendation.id as string, linkId: link.id };
    };

    it('publishes a candidate', async () => {
      const { entryId, linkId } = await candidate();

      await decide(editor, linkId, { status: 'PUBLISHED' }).expect(200);

      const entry = (await board(patron).expect(200)).body.items.find(
        (i: { id: string }) => i.id === entryId,
      );
      expect(entry.links).toEqual([expect.objectContaining({ url: 'https://example.test/akira' })]);
    });

    it('discards one', async () => {
      const { entryId, linkId } = await candidate();

      await discard(editor, linkId).expect(204);

      expect(await linksOn(entryId)).toEqual([]);
    });

    it('publishes a candidate that is marked preferred, since a hidden favourite is no favourite', async () => {
      const { linkId } = await candidate();

      await decide(editor, linkId, { isPreferred: true }).expect(200);

      const [link] = await linksOn(
        (await ctx.prisma.recommendationLink.findUniqueOrThrow({ where: { id: linkId } }))
          .recommendationId,
      );
      expect(link).toMatchObject({ isPreferred: true, status: 'PUBLISHED' });
    });

    it('refuses a moderator without EDIT_ENTRIES', async () => {
      const { linkId } = await candidate();

      await decide(bystander, linkId, { status: 'PUBLISHED' }).expect(403);
    });

    it('refuses a patron', async () => {
      const { linkId } = await candidate();

      await decide(patron, linkId, { status: 'PUBLISHED' }).expect(403);
    });

    it('404s a link on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'lk-other',
          ownerUserId: await userId('lk-owner'),
          displayName: 'Other',
          slug: 'lk-other',
          policy: { create: {} },
        },
      });
      const foreignEntry = await ctx.prisma.recommendation.create({
        data: {
          creatorId: other.id,
          submittedByUserId: await userId('lk-patron'),
          type: 'EXTERNAL_LINK',
          customTitle: 'Elsewhere',
          normalizedTitle: 'elsewhere',
        },
      });
      const foreignLink = await ctx.prisma.recommendationLink.create({
        data: {
          recommendationId: foreignEntry.id,
          url: 'https://example.test/x',
          canonicalUrl: canonicalUrl('https://example.test/x'),
        },
      });

      await decide(editor, foreignLink.id, { status: 'PUBLISHED' }).expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });
  });
});
