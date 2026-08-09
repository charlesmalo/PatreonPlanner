import { Injectable, Logger } from '@nestjs/common';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PrismaService } from '../prisma/prisma.service';

interface PledgePayload {
  data?: {
    attributes?: { patron_status?: string; currently_entitled_amount_cents?: number };
    relationships?: {
      user?: { data?: { id?: string } };
      campaign?: { data?: { id?: string } };
      currently_entitled_tiers?: { data?: Array<{ id: string }> };
    };
  };
}

const HANDLED = new Set([
  'members:pledge:create',
  'members:pledge:update',
  'members:pledge:delete',
]);

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly memberships: MembershipSyncService,
    private readonly prisma: PrismaService,
  ) {}

  async handle(trigger: string | undefined, payload: PledgePayload): Promise<void> {
    if (!trigger || !HANDLED.has(trigger)) return;

    const patreonUserId = payload.data?.relationships?.user?.data?.id;
    const campaignId = payload.data?.relationships?.campaign?.data?.id;
    if (!patreonUserId || !campaignId) {
      this.logger.warn(`Discarding ${trigger} with no user or campaign reference`);
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { patreonUserId },
      select: { id: true },
    });
    // A patron who has never logged in has no User row to attach to. Login re-sync will pick
    // them up; inventing a shell user here would create an account nobody can sign into.
    if (!user) return;

    const isDelete = trigger === 'members:pledge:delete';
    const attributes = payload.data?.attributes;

    await this.memberships.applyIdentity(
      user.id,
      isDelete
        ? []
        : [
            {
              campaignId,
              patreonTierIds: (
                payload.data?.relationships?.currently_entitled_tiers?.data ?? []
              ).map((tier) => tier.id),
              amountCents: attributes?.currently_entitled_amount_cents ?? 0,
              isActivePatron: attributes?.patron_status === 'active_patron',
            },
          ],
      // Scoped: this event speaks only for its own campaign. Unscoped, an empty list from a
      // delete would revoke the user's access to every other creator they support.
      { onlyCampaignIds: [campaignId] },
    );
  }
}
