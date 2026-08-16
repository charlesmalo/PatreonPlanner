import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { ThemesService } from '../src/intelligence/themes.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Theme curation (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let patron: Auth;
  let staff: Auth;
  let themeId: string;
  let titleId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'th-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'th-campaign',
        ownerUserId: owner.id,
        displayName: 'Theme Co',
        slug: 'theme-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'th-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'th-other',
          policy: { create: {} },
        },
      })
    ).id;

    patron = await loginAs('th-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'th-patron' } }))
          .id,
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });
    staff = await loginAs('th-staff');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'th-staff' } }))
          .id,
        role: 'MOD',
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.titleTheme.deleteMany();
    await ctx.prisma.theme.deleteMany();
    await ctx.prisma.title.deleteMany();
    titleId = (
      await ctx.prisma.title.create({ data: { tmdbId: 1, mediaType: 'MOVIE', name: 'A Film' } })
    ).id;
    themeId = (
      await ctx.prisma.theme.create({
        data: { creatorId, name: 'Anime', slug: 'anime' },
      })
    ).id;
    await ctx.prisma.titleTheme.create({ data: { titleId, themeId } });
    await ctx.prisma.themeSource.create({ data: { creatorId, sourceKey: 'anime', themeId } });
  });

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

  const list = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/theme-co/themes')
      .set('Cookie', [auth.session, auth.csrf]);

  const patch = (auth: Auth, id: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/theme-co/themes/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const remove = (auth: Auth, id: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1/creators/theme-co/themes/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const merge = (auth: Auth, id: string, body: object) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/theme-co/themes/${id}/merge`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  it('lists the creator themes with how many board entries carry each', async () => {
    const user = await ctx.prisma.user.findFirstOrThrow({ where: { patreonUserId: 'th-patron' } });
    await ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: user.id,
        type: 'MOVIE',
        titleId,
        customTitle: 'A Film',
        normalizedTitle: 'a film',
      },
    });
    const res = await list(patron).expect(200);
    expect(res.body.items).toEqual([{ id: themeId, name: 'Anime', entryCount: 1 }]);
  });

  it('does not count entries a reader cannot see', async () => {
    // A TitleTheme survives its entry being rejected, so counting rows advertised a filter that
    // returned fewer results than it promised — and leaked how many hidden entries it covered.
    const user = await ctx.prisma.user.findFirstOrThrow({ where: { patreonUserId: 'th-patron' } });
    await ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: user.id,
        type: 'MOVIE',
        titleId,
        customTitle: 'A Film',
        normalizedTitle: 'a film',
        status: 'REJECTED',
      },
    });
    const res = await list(patron).expect(200);
    expect(res.body.items[0].entryCount).toBe(0);
  });

  it('never lists another creator themes', async () => {
    await ctx.prisma.theme.create({
      data: { creatorId: otherCreatorId, name: 'Foreign', slug: 'foreign' },
    });
    const res = await list(patron).expect(200);
    expect(res.body.items.map((t: { name: string }) => t.name)).toEqual(['Anime']);
  });

  it('renames a theme and keeps its assignments', async () => {
    await patch(staff, themeId, { name: 'Cartoons' }).expect(200);
    const row = await ctx.prisma.theme.findUniqueOrThrow({ where: { id: themeId } });
    expect(row).toMatchObject({ name: 'Cartoons', slug: 'cartoons' });
    // The label mapping is untouched, which is what stops re-seeding from resurrecting the old
    // name the next time a title carrying that TMDB keyword lands on the board.
    const sources = await ctx.prisma.themeSource.findMany({ where: { themeId } });
    expect(sources.map((s) => s.sourceKey)).toEqual(['anime']);
    expect(await ctx.prisma.titleTheme.count({ where: { themeId } })).toBe(1);
  });

  it('refuses a rename from a patron', async () => {
    await patch(patron, themeId, { name: 'Mine' }).expect(403);
  });

  it('refuses a rename that collides with an existing theme', async () => {
    const other = await ctx.prisma.theme.create({
      data: { creatorId, name: 'Fantasy', slug: 'fantasy' },
    });
    await patch(staff, other.id, { name: 'anime' }).expect(409);
  });

  it('allows a rename that only changes the casing of its own name', async () => {
    // The collision check must not treat a theme as colliding with itself.
    await patch(staff, themeId, { name: 'ANIME' }).expect(200);
  });

  it('runs a rename through moderation', async () => {
    // Theme names are shown on a public board, so they are user strings like any other.
    await patch(staff, themeId, { name: 'this is shit' }).expect(400);
  });

  it('refuses a theme belonging to another creator', async () => {
    const foreign = await ctx.prisma.theme.create({
      data: { creatorId: otherCreatorId, name: 'Foreign', slug: 'foreign' },
    });
    await patch(staff, foreign.id, { name: 'Mine' }).expect(404);
    await remove(staff, foreign.id).expect(404);
  });

  it('404s an unknown theme', async () => {
    await patch(staff, randomUUID(), { name: 'X' }).expect(404);
  });

  it('deletes a theme and its assignments without touching the title', async () => {
    await remove(staff, themeId).expect(204);
    expect(await ctx.prisma.theme.count({ where: { id: themeId } })).toBe(0);
    expect(await ctx.prisma.titleTheme.count()).toBe(0);
    expect(await ctx.prisma.title.count({ where: { id: titleId } })).toBe(1);
  });

  describe('merging', () => {
    let target: string;
    let otherTitleId: string;

    beforeEach(async () => {
      target = (
        await ctx.prisma.theme.create({
          data: { creatorId, name: 'Animation', slug: 'animation' },
        })
      ).id;
      await ctx.prisma.themeSource.create({
        data: { creatorId, sourceKey: 'animation', themeId: target },
      });
      otherTitleId = (
        await ctx.prisma.title.create({ data: { tmdbId: 2, mediaType: 'MOVIE', name: 'B Film' } })
      ).id;
    });

    it('moves the losing theme titles onto the winner and removes the loser', async () => {
      const res = await merge(staff, themeId, { intoId: target }).expect(200);

      expect(res.body).toEqual({ id: target, name: 'Animation' });
      const links = await ctx.prisma.titleTheme.findMany({ where: { themeId: target } });
      expect(links.map((l) => l.titleId)).toEqual([titleId]);
      expect(await ctx.prisma.theme.findUnique({ where: { id: themeId } })).toBeNull();
    });

    it('does not resurrect the merged-away theme on the next enrichment pass', async () => {
      // The whole point of the feature. "anime" was seeded from a TMDB label; if the merge leaves
      // that label unclaimed, the next title carrying it re-creates the theme the creator just
      // folded away — and they have no way to make it stop.
      await merge(staff, themeId, { intoId: target }).expect(200);
      await ctx.app.get(ThemesService).seedFor(otherTitleId, creatorId, ['Anime']);

      const themes = await ctx.prisma.theme.findMany({ where: { creatorId } });
      expect(themes.map((t) => t.id)).toEqual([target]);
      const links = await ctx.prisma.titleTheme.findMany({ where: { titleId: otherTitleId } });
      expect(links.map((l) => l.themeId)).toEqual([target]);
    });

    it('survives a title that carried both themes', async () => {
      await ctx.prisma.titleTheme.create({ data: { titleId, themeId: target } });

      await merge(staff, themeId, { intoId: target }).expect(200);

      expect(await ctx.prisma.titleTheme.count({ where: { titleId } })).toBe(1);
    });

    it('refuses to merge a theme into itself', async () => {
      // Not a no-op to wave through: it means the caller confused the two ids, and reporting
      // success would have them believe a merge happened.
      await merge(staff, themeId, { intoId: themeId }).expect(400);
      expect(await ctx.prisma.theme.findUnique({ where: { id: themeId } })).not.toBeNull();
    });

    it('refuses a target on another creator board', async () => {
      const foreign = await ctx.prisma.theme.create({
        data: { creatorId: otherCreatorId, name: 'Foreign', slug: 'foreign' },
      });

      await merge(staff, themeId, { intoId: foreign.id }).expect(404);

      expect(await ctx.prisma.titleTheme.count({ where: { themeId: foreign.id } })).toBe(0);
      expect(await ctx.prisma.theme.findUnique({ where: { id: themeId } })).not.toBeNull();
    });

    it('refuses a source on another creator board', async () => {
      const foreign = await ctx.prisma.theme.create({
        data: { creatorId: otherCreatorId, name: 'Foreign', slug: 'foreign' },
      });

      await merge(staff, foreign.id, { intoId: target }).expect(404);

      expect(await ctx.prisma.theme.findUnique({ where: { id: foreign.id } })).not.toBeNull();
    });

    it('refuses a merge from a patron', async () => {
      await merge(patron, themeId, { intoId: target }).expect(403);
      expect(await ctx.prisma.theme.findUnique({ where: { id: themeId } })).not.toBeNull();
    });

    it('does not lose data when two merges chain through the same theme', async () => {
      // A creator cleaning up three duplicates fires X into Y and Y into Z without waiting. Both
      // used to return 200 while the second transaction, working from a snapshot taken before the
      // first one's writes landed, cascaded them away — leaving the title with no theme at all and
      // the label mapping gone, which re-arms the resurrection this feature exists to prevent.
      //
      // Two clients rather than two requests: the race needs genuinely separate connections, and
      // through one pool it did not reproduce at all. Repeated because the interleaving is not
      // guaranteed; unfixed this lost data in 8 rounds out of 10.
      const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      const mergeVia = (db: PrismaClient, from: string, into: string) =>
        new ThemesService(db as never).merge(creatorId, from, into).catch((error: Error) => error);

      try {
        for (let round = 0; round < 5; round += 1) {
          const [x, y, z] = await Promise.all(
            ['x', 'y', 'z'].map((n) =>
              ctx.prisma.theme.create({
                data: { creatorId, name: `${n}${round}`, slug: `${n}${round}` },
              }),
            ),
          );
          const film = await ctx.prisma.title.create({
            data: { tmdbId: 7000 + round, mediaType: 'MOVIE', name: `Film ${round}` },
          });
          await ctx.prisma.titleTheme.create({ data: { titleId: film.id, themeId: x.id } });
          await ctx.prisma.themeSource.create({
            data: { creatorId, sourceKey: `x${round}`, themeId: x.id },
          });

          await Promise.all([mergeVia(ctx.prisma, x.id, y.id), mergeVia(other, y.id, z.id)]);

          // Whichever way the two landed — and one of them may legitimately 404, having lost its
          // theme while waiting on the lock — the title keeps a theme that still exists, and the
          // label keeps a home on a theme that still exists.
          const survivors = await ctx.prisma.theme.findMany({
            where: { id: { in: [x.id, y.id, z.id] } },
            select: { id: true },
          });
          const ids = survivors.map((t) => t.id);
          const links = await ctx.prisma.titleTheme.findMany({ where: { titleId: film.id } });
          const sources = await ctx.prisma.themeSource.findMany({
            where: { creatorId, sourceKey: `x${round}` },
          });

          expect({ round, links: links.length, sources: sources.length }).toEqual({
            round,
            links: 1,
            sources: 1,
          });
          expect(ids).toContain(links[0].themeId);
          expect(ids).toContain(sources[0].themeId);
        }
      } finally {
        await other.$disconnect();
      }
    });

    it('does not lose a title themes when a merge lands mid-enrichment', async () => {
      // The enrichment job resolves every label before writing any assignment, so a merge
      // committing inside that window left the resolved ids pointing at a theme that no longer
      // exists: a foreign key violation that cost the title every one of its labels, permanently,
      // because enrichedAt is stamped either way. The other order was worse — the assignment
      // committed and was then quietly cascaded away by the merge's delete.
      const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      const themes = ctx.app.get(ThemesService);

      try {
        for (let round = 0; round < 5; round += 1) {
          const loser = await ctx.prisma.theme.create({
            data: { creatorId, name: `Seeded${round}`, slug: `seeded${round}` },
          });
          await ctx.prisma.themeSource.create({
            data: { creatorId, sourceKey: `seeded${round}`, themeId: loser.id },
          });
          const film = await ctx.prisma.title.create({
            data: { tmdbId: 7100 + round, mediaType: 'MOVIE', name: `Mid ${round}` },
          });

          const [, mergeResult] = await Promise.all([
            themes.seedFor(film.id, creatorId, [`Seeded${round}`]),
            new ThemesService(other as never)
              .merge(creatorId, loser.id, target)
              .catch((error: Error) => error),
          ]);
          expect(mergeResult).not.toBeInstanceOf(Error);

          // The title ends up on the surviving theme either way: the seed either wrote to the
          // loser before it was folded in, or resolved again afterwards and wrote to the winner.
          const links = await ctx.prisma.titleTheme.findMany({ where: { titleId: film.id } });
          expect(links.map((l) => l.themeId)).toEqual([target]);
        }
      } finally {
        await other.$disconnect();
      }
    });

    it('recovers when another enrichment pass records the same label first', async () => {
      // Prisma compiles an upsert with an empty update to a select followed by an insert, not to
      // ON CONFLICT — verified from its query log — so two passes reaching that line together
      // leave one holding a P2002. Unhandled, it cost the title every one of its labels,
      // permanently, since enrichedAt is stamped either way.
      //
      // The interleaving is forced rather than raced: through one process the two round trips do
      // not reliably overlap, and a test that only sometimes reproduces the bug is not a test.
      // The competing row is really inserted, so the recovery path reads real data.
      await ctx.prisma.themeSource.deleteMany({ where: { creatorId, sourceKey: 'anime' } });
      const rival = await ctx.prisma.theme.create({
        data: { creatorId, name: 'Rival', slug: 'rival' },
      });
      let raced = false;
      const prisma = {
        theme: ctx.prisma.theme,
        titleTheme: ctx.prisma.titleTheme,
        themeSource: {
          findUnique: (args: never) => ctx.prisma.themeSource.findUnique(args),
          create: async (args: {
            data: { creatorId: string; sourceKey: string; themeId: string };
          }) => {
            if (raced) return ctx.prisma.themeSource.create(args);
            raced = true;
            await ctx.prisma.themeSource.create({ data: { ...args.data, themeId: rival.id } });
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: '5.20.0',
            });
          },
        },
      };

      await new ThemesService(prisma as never).seedFor(otherTitleId, creatorId, ['Anime']);

      // Whoever recorded the label first owns it, and the title lands on their theme rather than
      // on a second one carrying the same meaning.
      expect(await ctx.prisma.themeSource.count({ where: { creatorId, sourceKey: 'anime' } })).toBe(
        1,
      );
      const links = await ctx.prisma.titleTheme.findMany({ where: { titleId: otherTitleId } });
      expect(links.map((l) => l.themeId)).toEqual([rival.id]);
    });

    it('reports the winner entry count as the union of both', async () => {
      const user = await ctx.prisma.user.findFirstOrThrow({
        where: { patreonUserId: 'th-patron' },
      });
      await ctx.prisma.titleTheme.create({ data: { titleId: otherTitleId, themeId: target } });
      for (const [id, title] of [
        [titleId, 'A Film'],
        [otherTitleId, 'B Film'],
      ] as const) {
        await ctx.prisma.recommendation.create({
          data: {
            creatorId,
            submittedByUserId: user.id,
            type: 'MOVIE',
            titleId: id,
            customTitle: title,
            normalizedTitle: title.toLowerCase(),
          },
        });
      }

      await merge(staff, themeId, { intoId: target }).expect(200);

      const res = await list(patron).expect(200);
      expect(res.body.items).toEqual([{ id: target, name: 'Animation', entryCount: 2 }]);
    });
  });

  it('refuses a delete from a patron', async () => {
    await remove(patron, themeId).expect(403);
  });
});
