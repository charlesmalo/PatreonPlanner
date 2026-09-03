import { Injectable, Logger } from '@nestjs/common';
import { SuppressionReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Suppression } from './resend-webhook.adapter';

/**
 * Addresses this application must stop writing to.
 *
 * Mailbox providers judge a sender on whether it keeps mailing people who bounced or complained,
 * and suspend the ones that do. So this is about the sending domain's standing rather than about
 * any one reader — which is why it is enforced in the sender rather than in the digest, and why
 * every future email path inherits it without having to remember.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records addresses to stop mailing.
   *
   * `skipDuplicates`, because the same address bouncing twice is the ordinary case and not an
   * error. The first reason is kept: an address that hard-bounced and later drew a complaint is
   * already off the list, and rewriting why would lose the earlier and more actionable fact.
   */
  async suppress(suppressions: Suppression[]): Promise<number> {
    if (suppressions.length === 0) return 0;

    const { count } = await this.prisma.emailSuppression.createMany({
      data: suppressions.map((entry) => ({
        address: normalise(entry.address),
        reason: entry.reason,
        detail: entry.detail,
      })),
      skipDuplicates: true,
    });
    if (count > 0) {
      this.logger.warn(
        `Suppressed ${count} address(es): ${suppressions.map((s) => s.reason).join(', ')}`,
      );
    }
    return count;
  }

  /**
   * Whether this address is on the list.
   *
   * Compared lowercased, because that is how it is stored and because the routing part of an
   * address is case-insensitive — a check that misses "Ada@example.com" while holding
   * "ada@example.com" protects nothing.
   */
  async isSuppressed(address: string): Promise<boolean> {
    const found = await this.prisma.emailSuppression.findUnique({
      where: { address: normalise(address) },
      select: { address: true },
    });
    return found !== null;
  }

  /** For a caller that wants to know why, rather than only whether. */
  async reasonFor(address: string): Promise<SuppressionReason | null> {
    const found = await this.prisma.emailSuppression.findUnique({
      where: { address: normalise(address) },
      select: { reason: true },
    });
    return found?.reason ?? null;
  }
}

function normalise(address: string): string {
  return address.trim().toLowerCase();
}
