import { createHmac } from 'node:crypto';
import { WebhookSignatureService } from '../src/webhooks/webhook-signature.service';

describe('WebhookSignatureService', () => {
  const secret = 'creator-webhook-secret';
  const service = new WebhookSignatureService();

  const sign = (body: Buffer, key = secret) => createHmac('md5', key).update(body).digest('hex');

  it('accepts a correctly signed body', () => {
    const body = Buffer.from('{"data":{"id":"1"}}');
    expect(service.verify(body, sign(body), secret)).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const body = Buffer.from('{"data":{"id":"1"}}');
    expect(service.verify(Buffer.from('{"data":{"id":"2"}}'), sign(body), secret)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(service.verify(Buffer.from('{}'), undefined, secret)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so this must be guarded rather than 500.
    expect(service.verify(Buffer.from('{}'), 'abc', secret)).toBe(false);
  });

  it('rejects a signature that is not hex', () => {
    expect(service.verify(Buffer.from('{}'), 'z'.repeat(32), secret)).toBe(false);
  });

  it('is sensitive to whitespace, so a re-serialized body cannot pass', () => {
    const body = Buffer.from('{"a":1}');
    expect(service.verify(Buffer.from('{ "a": 1 }'), sign(body), secret)).toBe(false);
  });

  it('rejects a signature computed with another creator’s secret', () => {
    const body = Buffer.from('{"a":1}');
    // The whole point of per-creator secrets: one creator's key must not validate elsewhere.
    expect(service.verify(body, sign(body, 'someone-elses-secret'), secret)).toBe(false);
  });

  it('rejects a duplicated signature header', () => {
    const body = Buffer.from('{"a":1}');
    const doubled = `${sign(body)}, ${sign(body)}`;
    expect(service.verify(body, doubled, secret)).toBe(false);
  });
});
