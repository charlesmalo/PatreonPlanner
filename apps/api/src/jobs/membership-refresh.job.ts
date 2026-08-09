import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokenService } from '../patreon/patreon-token.service';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 50;
// How long before a user who failed to refresh is tried again. Long enough that a revoked
// token does not burn the batch every tick, short enough to recover the same day.
const RETRY_AFTER_MS = 60 * 60 * 1000;
// Tiers change rarely; re-reading every creator every tick would be 96 Patreon calls each per
// day to detect a monthly event.
const TIER_RESYNC_AFTER_MS = 24 * 60 * 60 * 1000;

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
    const retryCutoff = new Date(Date.now() - RETRY_AFTER_MS);

    // Selected on User, not Membership. `membership.findMany({ distinct, take })` emits no SQL
    // LIMIT — Prisma applies both in memory — so it read the whole table and then ordered by a
    // random uuid, which starved anyone behind a permanently failing user. Ordering by the
    // attempt stamp instead means a user who keeps failing rotates to the back of the queue.
    const stale = await this.prisma.user.findMany({
      where: {
        memberships: { some: { lastSyncedAt: { lt: cutoff } } },
        OR: [{ membershipsRefreshedAt: null }, { membershipsRefreshedAt: { lt: retryCutoff } }],
      },
      orderBy: { membershipsRefreshedAt: { sort: 'asc', nulls: 'first' } },
      select: { id: true },
      take: BATCH_SIZE,
    });

    let refreshed = 0;
    for (const { id: userId } of stale) {
      // Stamped before the attempt and regardless of outcome: a user whose token is revoked
      // must not hold a slot in every subsequent batch forever.
      await this.prisma.user.update({
        where: { id: userId },
        data: { membershipsRefreshedAt: new Date() },
      });
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
    // Ordered by when each was last re-synced, so every creator is eventually reached rather
    // than the first BATCH_SIZE by id being re-fetched from Patreon forever.
    const creators = await this.prisma.creator.findMany({
      where: {
        OR: [
          { tiersSyncedAt: null },
          { tiersSyncedAt: { lt: new Date(Date.now() - TIER_RESYNC_AFTER_MS) } },
        ],
      },
      orderBy: { tiersSyncedAt: { sort: 'asc', nulls: 'first' } },
      select: { id: true, patreonCampaignId: true, ownerUserId: true },
      take: BATCH_SIZE,
    });

    let updated = 0;
    for (const creator of creators) {
      // Stamped regardless of outcome, for the same reason as the membership batch.
      await this.prisma.creator.update({
        where: { id: creator.id },
        data: { tiersSyncedAt: new Date() },
      });
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
