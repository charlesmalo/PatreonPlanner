import { randomBytes } from 'node:crypto';
import { ConfigService } from '../src/config/config.module';
import { EncryptionService } from '../src/crypto/encryption.service';
import { applyTestConfigDefaults } from './support/env';

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    // A real random key rather than the all-zero test default, so the round-trip is not
    // accidentally passing on a degenerate key.
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    service = new EncryptionService(new ConfigService());
  });

  it('round-trips a token', () => {
    const plaintext = 'patreon-access-token-value';
    expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
  });

  it('never emits the plaintext in the ciphertext payload', () => {
    const payload = service.encrypt('super-secret-token');
    expect(payload).not.toContain('super-secret-token');
  });

  it('produces a different ciphertext each time for the same input', () => {
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('rejects a tampered payload rather than returning garbage', () => {
    const payload = service.encrypt('token');
    const [version, iv, tag, data] = payload.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64')].join(':');
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('refuses a payload written under an unknown version', () => {
    const payload = service.encrypt('token');
    const [, iv, tag, data] = payload.split(':');
    expect(() => service.decrypt(['v99', iv, tag, data].join(':'))).toThrow(
      'Unsupported ciphertext version',
    );
  });
});
