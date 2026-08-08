import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

/**
 * Signed, session-bound CSRF tokens: `<random>.<HMAC(key, random ‖ sessionFingerprint)>`.
 *
 * Plain double-submit only proves the two halves match, so anything able to write a cookie for
 * the registrable domain — an XSS on a sibling subdomain, or an active network attacker — can
 * plant a value it chose and satisfy both halves. Requiring a signature this server produced
 * removes that, and binding it to the session stops a token minted for one caller being
 * replayed by another.
 */
@Injectable()
export class CsrfTokenService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    // Domain-separated subkey, so the MAC never uses the same bytes as token encryption.
    this.key = createHmac('sha256', Buffer.from(config.get('ENCRYPTION_KEY'), 'base64'))
      .update('csrf-token-v1')
      .digest();
  }

  issue(sessionToken: string | undefined): string {
    const random = randomBytes(32).toString('base64url');
    return `${random}.${this.sign(random, sessionToken)}`;
  }

  verify(token: string | undefined, sessionToken: string | undefined): boolean {
    if (!token) return false;
    const [random, mac] = token.split('.');
    if (!random || !mac) return false;
    return equals(mac, this.sign(random, sessionToken));
  }

  /**
   * Bound to a fingerprint of the session cookie rather than the user id, so verification needs
   * no Redis round trip on every request. An anonymous caller binds to the empty string, which
   * is why a token minted before login stops verifying afterwards.
   */
  private sign(random: string, sessionToken: string | undefined): string {
    const fingerprint = sessionToken ? createHash('sha256').update(sessionToken).digest('hex') : '';
    return createHmac('sha256', this.key).update(`${random}.${fingerprint}`).digest('base64url');
  }
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so lengths must be compared first.
  return left.length === right.length && timingSafeEqual(left, right);
}
