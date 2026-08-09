import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

// Patreon's documented scheme. MD5 is theirs, not ours: anyone holding the secret can forge
// events, which is why the secret is per creator rather than global — one shared secret would
// make every creator's authorization depend on every other creator keeping it.
const ALGORITHM = 'md5';
const SIGNATURE_LENGTH = 32;

@Injectable()
export class WebhookSignatureService {
  verify(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
    // Node joins duplicate headers with ", ", so a doubled signature fails this length check
    // rather than being silently accepted on its first copy.
    if (!signature || signature.length !== SIGNATURE_LENGTH) return false;
    const expected = createHmac(ALGORITHM, secret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    // Lengths are equal by the check above, but compare anyway: timingSafeEqual throws on a
    // mismatch, and a throw here would be a 500 rather than a rejection.
    return provided.length === computed.length && timingSafeEqual(provided, computed);
  }
}
