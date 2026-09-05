import request from 'supertest';
import { DIGEST_BATCH, DigestService } from '../src/email/digest.service';
import { EmailSender, type Email } from '../src/email/email-sender';
import { UnsubscribeTokenService } from '../src/email/unsubscribe-token.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('Email digests (integration)', () => {
  let ctx: AuthTestContext;
  let digest: DigestService;
  let tokens: UnsubscribeTokenService;
  let sender: EmailSender;
  let creatorId: string;
  let reader: string;

  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    ctx = await startAuthApp();
    digest = ctx.app.get(DigestService);
    tokens = ctx.app.get(UnsubscribeTokenService);
    sender = ctx.app.get(EmailSender);

    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'ed-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'ed-campaign',
          ownerUserId: owner.id,
          displayName: 'Digest Co',
          slug: 'digest-co',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: { create: { userId: owner.id, role: 'OWNER' } },
        },
      })
    ).id;
    reader = (
      await ctx.prisma.user.create({
        data: { patreonUserId: 'ed-reader', email: 'reader@example.test' },
      })
    ).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.prisma.notification.deleteMany();
    await ctx.prisma.user.update({
      where: { id: reader },
      data: { emailDigest: true, lastDigestAt: null, email: 'reader@example.test' },
    });
  });

  const sent = () => jest.spyOn(sender, 'send').mockResolvedValue(undefined);

  const news = (title = 'Cowboy Bebop', createdAt = new Date()) =>
    ctx.prisma.notification.create({
      data: {
        userId: reader,
        creatorId,
        type: 'ENTRY_MOVED',
        createdAt,
        payload: {
          recommendationId: '00000000-0000-4000-8000-000000000001',
          title,
          creatorSlug: 'digest-co',
          creatorName: 'Digest Co',
          status: 'ACTIVE',
        },
      },
    });

  const lastDigestAt = async () =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { id: reader } })).lastDigestAt;

  describe('who gets one', () => {
    it('sends to a reader who opted in and has news', async () => {
      const spy = sent();
      await news();

      expect(await digest.runOnce()).toBe(1);

      const email = spy.mock.calls[0][0] as Email;
      expect(email.to).toBe('reader@example.test');
      expect(email.text).toContain('Cowboy Bebop');
    });

    it('sends nothing to a reader who never opted in', async () => {
      // The address came from Patreon's OAuth, for signing in. Sending a digest to it is a
      // different purpose from the one it was handed over for.
      const spy = sent();
      await ctx.prisma.user.update({ where: { id: reader }, data: { emailDigest: false } });
      await news();

      expect(await digest.runOnce()).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('sends nothing when there is no news', async () => {
      // A daily email saying nothing happened is how people unsubscribe.
      const spy = sent();

      expect(await digest.runOnce()).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      expect(await lastDigestAt()).toBeNull();
    });

    it('skips a reader with no address', async () => {
      const spy = sent();
      await ctx.prisma.user.update({ where: { id: reader }, data: { email: null } });
      await news();

      await digest.runOnce();

      expect(spy).not.toHaveBeenCalled();
    });

    it('does not repeat what a previous digest already carried', async () => {
      const spy = sent();
      await news('Old News', new Date(Date.now() - 2 * DAY));
      await ctx.prisma.user.update({
        where: { id: reader },
        data: { lastDigestAt: new Date(Date.now() - DAY) },
      });
      await news('New News');

      await digest.runOnce();

      const email = spy.mock.calls[0][0] as Email;
      expect(email.text).toContain('New News');
      expect(email.text).not.toContain('Old News');
    });
  });

  describe('when sending fails', () => {
    it('leaves the watermark alone, so tomorrow still carries today', async () => {
      // Moving it before the send would lose a day's news to a provider outage, silently.
      jest.spyOn(sender, 'send').mockRejectedValue(new Error('provider down'));
      await news();

      expect(await digest.runOnce()).toBe(0);

      expect(await lastDigestAt()).toBeNull();
    });

    it('keeps going for everybody else', async () => {
      // One unreachable address must not strand the rest of the batch behind it.
      const other = await ctx.prisma.user.create({
        data: { patreonUserId: 'ed-other', email: 'other@example.test', emailDigest: true },
      });
      await ctx.prisma.notification.create({
        data: {
          userId: other.id,
          creatorId,
          type: 'ENTRY_MOVED',
          payload: { title: 'Theirs', creatorName: 'Digest Co', status: 'ACTIVE' },
        },
      });
      await news();
      jest
        .spyOn(sender, 'send')
        .mockImplementationOnce(() => Promise.reject(new Error('down')))
        .mockResolvedValue(undefined);

      expect(await digest.runOnce()).toBe(1);

      await ctx.prisma.user.delete({ where: { id: other.id } });
    });
  });

  describe('the unsubscribe link', () => {
    it('is in every digest', async () => {
      const spy = sent();
      await news();

      await digest.runOnce();

      expect((spy.mock.calls[0][0] as Email).text).toContain('/api/v1/email/unsubscribe');
    });

    it('turns the digest off, with no session', async () => {
      const link = tokens.linkFor(reader);
      const url = new URL(link);

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/email/unsubscribe${url.search}`)
        .expect(200);

      const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: reader } });
      expect(after.emailDigest).toBe(false);
    });

    it('refuses a token that was not signed for that reader', async () => {
      // A bare id here would let anybody unsubscribe anybody by changing the URL.
      const other = await ctx.prisma.user.create({
        data: { patreonUserId: 'ed-victim', emailDigest: true },
      });
      const theirToken = new URL(tokens.linkFor(other.id)).searchParams.get('t');

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/email/unsubscribe?u=${reader}&t=${theirToken}`)
        .expect(400);

      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: reader } })).emailDigest).toBe(
        true,
      );
      await ctx.prisma.user.delete({ where: { id: other.id } });
    });

    it('refuses a tampered token', async () => {
      await request(ctx.app.getHttpServer())
        .get(`/api/v1/email/unsubscribe?u=${reader}&t=deadbeef`)
        .expect(400);
    });

    it('answers the same way for a reader that does not exist', async () => {
      // Distinguishing "bad signature" from "no such user" turns this into a way to test whether
      // an id is real.
      const ghost = '00000000-0000-4000-8000-00000000dead';
      const token = new URL(tokens.linkFor(ghost)).searchParams.get('t');

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/email/unsubscribe?u=${ghost}&t=${token}`)
        .expect(200);
    });
  });

  it('takes a bounded batch', async () => {
    const spy = sent();
    const many = await Promise.all(
      Array.from({ length: DIGEST_BATCH + 3 }, (_, i) =>
        ctx.prisma.user.create({
          data: { patreonUserId: `ed-many-${i}`, email: `m${i}@example.test`, emailDigest: true },
        }),
      ),
    );
    await ctx.prisma.notification.createMany({
      data: many.map((u) => ({
        userId: u.id,
        creatorId,
        type: 'ENTRY_MOVED' as const,
        payload: { title: 'Batch', creatorName: 'Digest Co', status: 'ACTIVE' },
      })),
    });

    await digest.runOnce();

    expect(spy.mock.calls.length).toBeLessThanOrEqual(DIGEST_BATCH);
    await ctx.prisma.user.deleteMany({ where: { patreonUserId: { startsWith: 'ed-many-' } } });
  });
});
