import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokenService } from '../patreon/patreon-token.service';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 50;

@Injectable()
export class MembershipRefreshJob {
  private readonly logger = new Logger(MembershipRefreshJob.name);

  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly tokens: PatreonTokenService,
    private readonly memberships: MembershipSyncService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Design §4's fallback for webhooks that were missed, dropped, or never configured.
   * Returns how many users were successfully refreshed.
   */
  async runOnce(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.get('MEMBERSHIP_TTL_HOURS') * 60 * 60 * 1000);
    const stale = await this.prisma.membership.findMany({
      where: { lastSyncedAt: { lt: cutoff } },
      select: { userId: true },
      distinct: ['userId'],
      take: BATCH_SIZE,
    });

    let refreshed = 0;
    for (const { userId } of stale) {
      try {
        const identity = await this.patreon.fetchIdentity(await this.tokens.getAccessToken(userId));
        await this.memberships.applyIdentity(userId, identity.memberships);
        refreshed += 1;
      } catch (error) {
        // One user's revoked token or Patreon hiccup must not abandon the batch; theirs stays
        // stale and is retried next run.
        this.logger.warn(
          `Membership refresh failed for user ${userId}: ${(error as Error).message}`,
        );
      }
    }
    if (refreshed > 0) this.logger.log(`Refreshed memberships for ${refreshed} user(s)`);
    return refreshed;
  }

  /**
   * Re-reads each claimed creator's tiers using the owner's token. Upsert-only: Plan 03 made
   * policy gate tiers onDelete: Restrict precisely so a re-sync could not silently widen a gate,
   * so a tier removed on Patreon lingers here instead — visible, and harmless to gates.
   */
  async resyncTiers(): Promise<number> {
    const creators = await this.prisma.creator.findMany({
      select: { id: true, patreonCampaignId: true, ownerUserId: true },
      take: BATCH_SIZE,
    });

    let updated = 0;
    for (const creator of creators) {
      try {
        const campaigns = await this.patreon.fetchOwnedCampaigns(
          await this.tokens.getAccessToken(creator.ownerUserId),
        );
        const campaign = campaigns.find((c) => c.campaignId === creator.patreonCampaignId);
        if (!campaign) continue;

        for (const tier of campaign.tiers) {
          await this.prisma.tier.upsert({
            where: {
              creatorId_patreonTierId: {
                creatorId: creator.id,
                patreonTierId: tier.patreonTierId,
              },
            },
            create: { creatorId: creator.id, ...tier },
            update: { title: tier.title, amountCents: tier.amountCents, order: tier.order },
          });
        }
        updated += 1;
      } catch (error) {
        this.logger.warn(
          `Tier re-sync failed for creator ${creator.id}: ${(error as Error).message}`,
        );
      }
    }
    return updated;
  }
}
