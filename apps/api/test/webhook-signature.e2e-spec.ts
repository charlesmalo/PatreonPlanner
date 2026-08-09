import { createHmac } from 'node:crypto';
import { ConfigService } from '../src/config/config.module';
import { WebhookSignatureService } from '../src/webhooks/webhook-signature.service';
import { applyTestConfigDefaults } from './support/env';

describe('WebhookSignatureService', () => {
  const secret = 'test-webhook-secret';
  let service: WebhookSignatureService;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    process.env.PATREON_WEBHOOK_SECRET = secret;
    service = new WebhookSignatureService(new ConfigService());
  });

  const sign = (body: Buffer) => createHmac('md5', secret).update(body).digest('hex');

  it('accepts a correctly signed body', () => {
    const body = Buffer.from('{"data":{"id":"1"}}');
    expect(service.verify(body, sign(body))).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const body = Buffer.from('{"data":{"id":"1"}}');
    expect(service.verify(Buffer.from('{"data":{"id":"2"}}'), sign(body))).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(service.verify(Buffer.from('{}'), undefined)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so this must be guarded rather than 500.
    expect(service.verify(Buffer.from('{}'), 'abc')).toBe(false);
  });

  it('rejects a signature that is not hex', () => {
    expect(service.verify(Buffer.from('{}'), 'z'.repeat(32))).toBe(false);
  });

  it('is sensitive to whitespace, so a re-serialized body cannot pass', () => {
    const body = Buffer.from('{"a":1}');
    expect(service.verify(Buffer.from('{ "a": 1 }'), sign(body))).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = Buffer.from('{"a":1}');
    const forged = createHmac('md5', 'not-the-secret').update(body).digest('hex');
    expect(service.verify(body, forged)).toBe(false);
  });
});
