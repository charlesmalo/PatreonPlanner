import { createHmac } from 'node:crypto';
import { ResendWebhookAdapter } from '../src/email/resend-webhook.adapter';

/**
 * Resend's bounce and complaint payloads, against the shapes their documentation publishes.
 *
 * Pure: no app, no database. Written from the docs before the handler, which is the habit that
 * found eight bugs in the payment adapter — every one of them a case that fails in a direction
 * nobody reports.
 */
describe('ResendWebhookAdapter', () => {
  const SECRET = 'whsec_' + Buffer.from('a-signing-secret-of-some-length').toString('base64');
  const adapter = new ResendWebhookAdapter({
    get: (key: string) => (key === 'RESEND_WEBHOOK_SECRET' ? SECRET : undefined),
  } as never);

  const bounced = (bounce: Record<string, unknown> = {}, to: unknown = ['ada@example.com']) => ({
    type: 'email.bounced',
    created_at: '2026-09-02T10:00:00.000Z',
    data: {
      email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
      to,
      from: 'PatreonPlanner <noreply@example.com>',
      subject: 'Your digest',
      bounce: { type: 'Permanent', subType: 'General', message: 'No such user', ...bounce },
    },
  });

  const complained = (to: unknown = ['ada@example.com']) => ({
    type: 'email.complained',
    created_at: '2026-09-02T10:00:00.000Z',
    data: { email_id: 'abc', to, from: 'x', subject: 'Your digest' },
  });

  describe('parse', () => {
    it('suppresses an address that permanently bounced', () => {
      expect(adapter.parse(bounced())).toEqual([
        { address: 'ada@example.com', reason: 'BOUNCED', detail: 'No such user' },
      ]);
    });

    it('does NOT suppress a temporary bounce', () => {
      // A full mailbox or a greylisting server is not a wrong address. Suppressing on one loses a
      // reader who did nothing — the same shape of mistake as revoking premium on a partial
      // refund, and just as silent.
      expect(adapter.parse(bounced({ type: 'Transient' }))).toEqual([]);
      expect(adapter.parse(bounced({ type: 'Temporary' }))).toEqual([]);
    });

    it('does not suppress a bounce whose type it does not recognise', () => {
      // Never guess towards suppression: the cost of a wrong guess is a reader who silently
      // stops hearing from us and never finds out why.
      expect(adapter.parse(bounced({ type: 'Sideways' }))).toEqual([]);
    });

    it('suppresses on a complaint, whatever else the payload says', () => {
      // Being marked as spam is the most expensive signal a sender gets. There is no
      // "temporary" version of it.
      expect(adapter.parse(complained())).toEqual([
        { address: 'ada@example.com', reason: 'COMPLAINED', detail: null },
      ]);
    });

    it('reads every recipient, because `to` is an array', () => {
      // Their payload sends an array even for one address. Treating it as a string suppresses
      // nothing at all and does so without erroring.
      expect(adapter.parse(bounced({}, ['one@example.com', 'two@example.com']))).toHaveLength(2);
    });

    it('lowercases the address, so the list cannot be case-dodged', () => {
      expect(adapter.parse(bounced({}, ['Ada@Example.COM']))[0].address).toBe('ada@example.com');
    });

    it('ignores an address that is not a string', () => {
      expect(adapter.parse(bounced({}, ['ok@example.com', 42, null]))).toHaveLength(1);
    });

    it.each([
      ['a delivery', 'email.delivered'],
      ['an open', 'email.opened'],
      ['a click', 'email.clicked'],
      ['a temporary delay', 'email.delivery_delayed'],
      ['a send', 'email.sent'],
    ])('ignores %s', (_label, type) => {
      expect(adapter.parse({ ...bounced(), type })).toEqual([]);
    });

    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['a number', 7],
      ['an array', []],
      ['an empty object', {}],
      ['no data block', { type: 'email.bounced' }],
      ['no recipients', { type: 'email.bounced', data: { bounce: { type: 'Permanent' } } }],
    ])('returns nothing for %s without throwing', (_label, body) => {
      // A throw is a 500, and a 500 is a delivery the provider retries until it disables the
      // endpoint.
      expect(() => adapter.parse(body)).not.toThrow();
      expect(adapter.parse(body)).toEqual([]);
    });
  });

  describe('verify', () => {
    /** Svix signs `${id}.${timestamp}.${body}` with the base64 secret after the whsec_ prefix. */
    const sign = (id: string, timestamp: string, raw: Buffer, secret = SECRET) => {
      const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      const signature = createHmac('sha256', key)
        .update(`${id}.${timestamp}.${raw.toString('utf8')}`)
        .digest('base64');
      return `v1,${signature}`;
    };

    const now = () => Math.floor(Date.now() / 1000).toString();

    it('accepts a correctly signed delivery', () => {
      const raw = Buffer.from(JSON.stringify(bounced()));
      const id = 'msg_1';
      const ts = now();

      expect(adapter.verify(raw, { id, timestamp: ts, signature: sign(id, ts, raw) })).toBe(true);
    });

    it('accepts when one of several offered signatures matches', () => {
      // The header carries a space-delimited list so a secret can be rotated without dropping
      // deliveries. Checking only the first would reject every message mid-rotation.
      const raw = Buffer.from(JSON.stringify(bounced()));
      const id = 'msg_1';
      const ts = now();
      const header = `v1,not-the-right-one ${sign(id, ts, raw)}`;

      expect(adapter.verify(raw, { id, timestamp: ts, signature: header })).toBe(true);
    });

    it('rejects a body altered after signing', () => {
      const raw = Buffer.from(JSON.stringify(bounced()));
      const id = 'msg_1';
      const ts = now();
      const signature = sign(id, ts, raw);

      const tampered = Buffer.from(JSON.stringify(complained()));
      expect(adapter.verify(tampered, { id, timestamp: ts, signature })).toBe(false);
    });

    it('rejects a signature made with another secret', () => {
      const raw = Buffer.from(JSON.stringify(bounced()));
      const id = 'msg_1';
      const ts = now();
      const other = 'whsec_' + Buffer.from('a-different-secret-entirely').toString('base64');

      expect(adapter.verify(raw, { id, timestamp: ts, signature: sign(id, ts, raw, other) })).toBe(
        false,
      );
    });

    it('rejects a signature over a different message id', () => {
      // The id is part of what is signed precisely so one delivery's signature cannot be
      // reattached to another.
      const raw = Buffer.from(JSON.stringify(bounced()));
      const ts = now();

      expect(
        adapter.verify(raw, { id: 'msg_2', timestamp: ts, signature: sign('msg_1', ts, raw) }),
      ).toBe(false);
    });

    it('rejects a replayed delivery from long ago', () => {
      // A captured request stays validly signed forever unless the timestamp is checked.
      const raw = Buffer.from(JSON.stringify(bounced()));
      const id = 'msg_1';
      const old = (Math.floor(Date.now() / 1000) - 3600).toString();

      expect(adapter.verify(raw, { id, timestamp: old, signature: sign(id, old, raw) })).toBe(
        false,
      );
    });

    it.each([
      ['a missing signature', { id: 'a', timestamp: '1', signature: undefined }],
      ['a missing id', { id: undefined, timestamp: '1', signature: 'v1,x' }],
      ['a missing timestamp', { id: 'a', timestamp: undefined, signature: 'v1,x' }],
      ['a non-numeric timestamp', { id: 'a', timestamp: 'soon', signature: 'v1,x' }],
      ['a malformed signature', { id: 'a', timestamp: '1', signature: 'nonsense' }],
    ])('rejects %s without throwing', (_label, headers) => {
      expect(() => adapter.verify(Buffer.from('{}'), headers)).not.toThrow();
      expect(adapter.verify(Buffer.from('{}'), headers)).toBe(false);
    });
  });

  describe('signingSecret', () => {
    it('is undefined when unset, which is what makes the endpoint refuse', () => {
      const unset = new ResendWebhookAdapter({ get: () => undefined } as never);
      expect(unset.signingSecret()).toBeUndefined();
    });
  });
});
