import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentDetails } from './payment-provider';

/** A page of history is a page; nobody scrolls their own receipts by the hundred. */
export const RECEIPT_PAGE = 50;

/**
 * What an account paid, and nothing about who they are.
 *
 * The merchant of record holds the name, the email address, the billing address and the card.
 * Everything here is the provider's own opaque references plus an amount — enough to show
 * somebody their history and send them to the real receipt, and not enough to be a billing record.
 */
@Injectable()
export class ReceiptService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a charge, or does nothing because this charge is already recorded.
   *
   * Takes the caller's transaction so the receipt and the subscription write land together: a
   * receipt for a subscription change that was rolled back is a charge in somebody's history that
   * never happened.
   *
   * `skipDuplicates` rather than a catch, because a P2002 raised inside a transaction aborts the
   * whole thing — the subscription write would be lost to a receipt we did not even need. Two
   * distinct events can legitimately carry one charge (a creation and a payment-succeeded for the
   * same order), and the second must be a no-op rather than a failure.
   */
  async record(
    tx: Prisma.TransactionClient,
    provider: string,
    userId: string,
    providerOrderId: string | null,
    payment: PaymentDetails,
  ): Promise<void> {
    await tx.paymentReceipt.createMany({
      data: [
        {
          userId,
          provider,
          providerReceiptId: payment.providerReceiptId,
          providerOrderId,
          amountCents: payment.amountCents,
          currency: payment.currency,
          paidAt: payment.paidAt,
          url: payment.url,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** This reader's own, newest first. Ordered by `(paidAt, id)`: two receipts can share a paidAt. */
  forUser(userId: string) {
    return this.prisma.paymentReceipt.findMany({
      where: { userId },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: RECEIPT_PAGE,
      // An explicit select, so a column added to the model later cannot start appearing in a
      // response without somebody deciding it should.
      select: {
        id: true,
        providerReceiptId: true,
        amountCents: true,
        currency: true,
        paidAt: true,
        url: true,
      },
    });
  }
}
