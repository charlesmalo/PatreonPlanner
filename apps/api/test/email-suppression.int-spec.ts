import { createHmac } from 'node:crypto';
import request from 'supertest';
import { EmailSender } from '../src/email/email-sender';
import { SuppressionService } from '../src/email/suppression.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

const SECRET = 'whsec_' + Buffer.from('suppression-test-secret-long-enough').toString('base64');

/**
 * Bounces and complaints, end to end.
 *
 * The point is the last test: an address that bounced must stop receiving mail. Everything before
 * it exists so that one cannot pass by accident.
 */
describe('Email suppression (integration)', () => {
  let ctx: AuthTestContext;
  let suppressions: SuppressionService;
  const previous = process.env.RESEND_WEBHOOK_SECRET;

  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    ctx = await startAuthApp();
    suppressions = ctx.app.get(SuppressionService);
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    // Given back, so a second run of the suite starts where the first did.
    if (previous === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = previous;
  });

  beforeEach(async () => {
    await ctx.prisma.emailSuppression.deleteMany();
  });

  const bounced = (address: string, type = 'Permanent') => ({
    type: 'email.bounced',
    created_at: new Date().toISOString(),
    data: {
      email_id: 'e1',
      to: [address],
      from: 'PatreonPlanner <noreply@example.com>',
      subject: 'Your digest',
      bounce: { type, subType: 'General', message: 'No such user' },
    },
  });

  const send = (payload: object, mangle?: (raw: string) => string) => {
    const raw = JSON.stringify(payload);
    const id = 'msg_' + Math.random().toString(36).slice(2);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
    const signature = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64');

    return request(ctx.app.getHttpServer())
      .post('/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', timestamp)
      .set('svix-signature', `v1,${signature}`)
      .send(mangle ? mangle(raw) : raw);
  };

  describe('the endpoint', () => {
    it('records a permanent bounce', async () => {
      await send(bounced('ada@example.com')).expect(200);

      expect(await suppressions.isSuppressed('ada@example.com')).toBe(true);
    });

    it('does not record a temporary one', async () => {
      // A full mailbox is not a wrong address, and suppressing on one loses a reader silently.
      await send(bounced('ada@example.com', 'Transient')).expect(200);

      expect(await suppressions.isSuppressed('ada@example.com')).toBe(false);
    });

    it('refuses a delivery whose body was altered after signing', async () => {
      await send(bounced('ada@example.com'), (raw) =>
        raw.replace('ada@example.com', 'someone@else.test'),
      ).expect(401);

      expect(await ctx.prisma.emailSuppression.count()).toBe(0);
    });

    it('refuses an unsigned delivery', async () => {
      await request(ctx.app.getHttpServer())
        .post('/webhooks/resend')
        .send(bounced('ada@example.com'))
        .expect(401);
    });

    it('is not behind CSRF, which would refuse the provider before the signature is read', async () => {
      // Exactly 401 rather than 403: a 403 would mean the middleware rejected it and the
      // signature check never ran, which is a different endpoint from the one being claimed.
      await request(ctx.app.getHttpServer())
        .post('/webhooks/resend')
        .send({ type: 'email.bounced' })
        .expect(401);
    });

    it('accepts an event it does not act on, rather than making the provider retry it', async () => {
      const response = await send({
        type: 'email.opened',
        data: { email_id: 'e1', to: ['ada@example.com'] },
      }).expect(200);

      expect(response.body).toMatchObject({ suppressed: 0 });
    });

    it('takes the same address twice without failing', async () => {
      await send(bounced('ada@example.com')).expect(200);
      await send(bounced('ada@example.com')).expect(200);

      expect(await ctx.prisma.emailSuppression.count()).toBe(1);
    });
  });

  describe('what it is for', () => {
    it('stops the sender writing to a suppressed address', async () => {
      // The whole feature in one assertion. Enforced in the sender rather than in the digest, so
      // any future email path is covered by it too.
      const sender = ctx.app.get(EmailSender);
      const sent: string[] = [];
      const inner = (sender as unknown as { inner: EmailSender }).inner;
      jest.spyOn(inner, 'send').mockImplementation(async (email) => {
        sent.push(email.to);
      });

      await sender.send({ to: 'fine@example.com', subject: 's', text: 't' });
      await send(bounced('gone@example.com')).expect(200);
      await sender.send({ to: 'gone@example.com', subject: 's', text: 't' });

      expect(sent).toEqual(['fine@example.com']);
      jest.restoreAllMocks();
    });

    it('matches an address whatever its case', async () => {
      await send(bounced('Ada@Example.COM')).expect(200);

      expect(await suppressions.isSuppressed('ada@example.com')).toBe(true);
      expect(await suppressions.isSuppressed('ADA@EXAMPLE.COM')).toBe(true);
    });
  });
});
