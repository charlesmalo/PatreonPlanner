import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
// Payloads carry a version tag so a future algorithm change can be told apart from this one.
// Note it does NOT yet enable key rotation: there is a single key and no key id in the payload,
// so changing ENCRYPTION_KEY makes every stored token undecryptable and forces re-authentication.
// Real rotation needs a key id segment plus a keyring.
const VERSION = 'v1';

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.get('ENCRYPTION_KEY'), 'base64');
  }

  encrypt(plaintext: string): string {
    // A fresh IV per call: reusing one under the same key would leak equality between
    // ciphertexts and break GCM's guarantees outright.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== VERSION) throw new Error('Unsupported ciphertext version');
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64'));
    // GCM verifies this tag in final(); a tampered payload throws rather than decrypting to
    // plausible-looking garbage.
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
