import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

// Patreon's documented scheme. MD5 is theirs, not ours: an attacker who learns the secret can
// forge events, so the secret is the whole of the security boundary here. What we control is
// comparing in constant time and verifying the raw bytes rather than a re-serialized body.
const ALGORITHM = 'md5';
const SIGNATURE_LENGTH = 32;

@Injectable()
export class WebhookSignatureService {
  constructor(private readonly config: ConfigService) {}

  verify(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || signature.length !== SIGNATURE_LENGTH) return false;
    const expected = createHmac(ALGORITHM, this.config.get('PATREON_WEBHOOK_SECRET'))
      .update(rawBody)
      .digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    // Length is already equal by the check above, but compare it anyway: timingSafeEqual throws
    // on a mismatch, and a throw here would be a 500 rather than a rejection.
    return provided.length === computed.length && timingSafeEqual(provided, computed);
  }
}
