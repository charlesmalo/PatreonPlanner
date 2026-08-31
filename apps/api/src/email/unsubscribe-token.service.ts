import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

/**
 * A link that works from a mail client, where the reader has no session.
 *
 * Signed rather than a bare id: an unsubscribe URL containing a user id lets anybody unsubscribe
 * anybody by changing it, and ids in this system are guessable to the extent that having seen one
 * tells you the shape of the rest. The HMAC is over the id alone, so the link does not expire —
 * an unsubscribe link that has stopped working is worse than one that still does.
 */
@Injectable()
export class UnsubscribeTokenService {
  private readonly key: Buffer;
  private readonly origin: string;

  constructor(config: ConfigService) {
    // Domain-separated subkey, the way CsrfTokenService derives its own.
    //
    // Standing practice rather than a defence against anything demonstrable here: a CSRF token is
    // a random value signed against a session and an unsubscribe token is a MAC over a user id, so
    // neither could be mistaken for the other even sharing a key. It costs nothing, and it keeps
    // being true when a third use of this key appears and is not so obviously different.
    // Deliberately not tested, because there is no confusion to demonstrate.
    this.key = createHmac('sha256', Buffer.from(config.get('ENCRYPTION_KEY'), 'base64'))
      .update('unsubscribe-v1')
      .digest();
    this.origin = config.get('WEB_ORIGIN');
  }

  linkFor(userId: string): string {
    return `${this.origin}/api/v1/email/unsubscribe?u=${userId}&t=${this.sign(userId)}`;
  }

  verify(userId: string, token: string): boolean {
    const expected = Buffer.from(this.sign(userId), 'utf8');
    const provided = Buffer.from(token, 'utf8');
    // Length first: timingSafeEqual throws on a mismatch, and a throw here would be a 500 rather
    // than the refusal it should be.
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private sign(userId: string): string {
    return createHmac('sha256', this.key).update(userId).digest('hex');
  }
}
