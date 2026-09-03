import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SuppressionReason } from '@prisma/client';
import { ConfigService } from '../config/config.module';

/**
 * The only file that knows what Resend's bounce and complaint deliveries look like.
 *
 * Written from their published payloads rather than from what seemed likely, which is the habit
 * that found eight bugs in the payment adapter. Two things here would have been wrong under any
 * reasonable guess: `data.to` is an **array** even for one recipient, and a bounce carries a
 * `type` that separates a permanent rejection from a temporary one.
 *
 * Signing is Svix, which Resend uses underneath: the signature covers `id.timestamp.body`, the
 * secret is base64 after a `whsec_` prefix, and the header holds a space-delimited list so a
 * secret can be rotated without dropping deliveries.
 */

export interface Suppression {
  address: string;
  reason: SuppressionReason;
  detail: string | null;
}

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * How far out of date a delivery may be. A captured request stays validly signed forever unless
 * the timestamp is checked, so this is what makes replaying one useless.
 */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Bounce types that mean the address is wrong, rather than the mailbox being briefly unavailable.
 *
 * Anything not on this list does **not** suppress — including a type nobody has seen before.
 * Guessing towards suppression costs a reader who did nothing, silently and permanently; guessing
 * away from it costs one more bounce, which the next delivery reports again.
 */
const PERMANENT = new Set(['Permanent']);

@Injectable()
export class ResendWebhookAdapter {
  constructor(private readonly config: ConfigService) {}

  /** Undefined means this instance cannot verify a delivery, and so must refuse every one. */
  signingSecret(): string | undefined {
    return this.config.get('RESEND_WEBHOOK_SECRET');
  }

  verify(rawBody: Buffer, headers: SvixHeaders): boolean {
    const secret = this.signingSecret();
    if (!secret) return false;

    const { id, timestamp, signature } = headers;
    if (!id || !timestamp || !signature) return false;

    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt)) return false;
    // Both directions: a clock ahead of ours is as much a sign of a forged timestamp as one behind.
    if (Math.abs(Math.floor(Date.now() / 1000) - sentAt) > TOLERANCE_SECONDS) return false;

    let key: Buffer;
    try {
      key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    } catch {
      return false;
    }
    const expected = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${rawBody.toString('utf8')}`)
      .digest('base64');

    // A space-delimited list, and any one of them matching is enough — that is what makes a
    // secret rotation possible without rejecting every message in the middle of it.
    return signature
      .split(' ')
      .filter((entry) => entry.startsWith('v1,'))
      .some((entry) => equals(entry.slice('v1,'.length), expected));
  }

  /**
   * Which addresses this delivery says to stop writing to. Empty for everything else.
   *
   * An array rather than one address because `data.to` is an array — a bounce can name several
   * recipients, and reading only the first would leave the others being mailed.
   *
   * Never throws. Anything unrecognised returns nothing, and the caller answers 2xx: a 4xx makes
   * the provider retry forever and eventually disable the endpoint.
   */
  parse(body: unknown): Suppression[] {
    const payload = asObject(body);
    if (!payload) return [];

    const data = asObject(payload.data);
    if (!data) return [];

    const recipients = Array.isArray(data.to)
      ? data.to.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
    if (recipients.length === 0) return [];

    // Lowercased: the routing part of an address is case-insensitive, and a list that holds
    // "ada@example.com" while a later send says "Ada@example.com" protects nothing.
    const addresses = recipients.map((address) => address.toLowerCase());

    if (payload.type === 'email.complained') {
      // No temporary version of this exists. Being marked as spam is the most expensive signal a
      // sender gets, and one is enough.
      return addresses.map((address) => ({
        address,
        reason: 'COMPLAINED' as SuppressionReason,
        detail: null,
      }));
    }

    if (payload.type === 'email.bounced') {
      const bounce = asObject(data.bounce);
      const type = typeof bounce?.type === 'string' ? bounce.type : '';
      if (!PERMANENT.has(type)) return [];

      const detail = typeof bounce?.message === 'string' ? bounce.message : null;
      return addresses.map((address) => ({
        address,
        reason: 'BOUNCED' as SuppressionReason,
        detail,
      }));
    }

    return [];
  }
}

/** Arrays excluded: `typeof [] === 'object'`, and an array has none of the fields read here. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function equals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length first: timingSafeEqual throws on a mismatch, and a throw here would be a 500 the
  // provider retries rather than the rejection it should be.
  return a.length === b.length && timingSafeEqual(a, b);
}
