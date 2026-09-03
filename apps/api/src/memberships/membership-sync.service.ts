import { Injectable } from '@nestjs/common';
import { PatreonMembership } from '../patreon/patreon.types';
import { PrismaService } from '../prisma/prisma.service';

export interface ApplyIdentityOptions {
  /**
   * Restrict reconciliation to these campaigns. A webhook speaks for one campaign only, so
   * without this the deactivation sweep below would revoke the user's access to every other
   * creator they support. Login and the staleness job see the full picture and omit it.
   */
  onlyCampaignIds?: string[];
}

@Injectable()
export class MembershipSyncService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reconciles a user's memberships against Patreon's view. Shared by login, the webhook and
   * the staleness job so all three grant and revoke by identical rules.
   */
  async applyIdentity(
    userId: string,
    memberships: PatreonMembership[],
    options: ApplyIdentityOptions = {},
  ): Promise<void> {
    const syncedCreatorIds: string[] = [];

    for (const membership of memberships) {
      const creator = await this.prisma.creator.findUnique({
        where: { patreonCampaignId: membership.campaignId },
        select: { id: true },
      });
      // Only a claimed campaign can carry a Membership; an unclaimed one has no tenant to
      // attach to and is skipped rather than half-created.
      if (!creator) continue;

      const patreonTierId = membership.patreonTierIds[0];
      const tier = patreonTierId
        ? await this.prisma.tier.findUnique({
            where: { creatorId_patreonTierId: { creatorId: creator.id, patreonTierId } },
            select: { id: true },
          })
        : null;

      const state = {
        currentTierId: tier?.id ?? null,
        amountCents: membership.amountCents,
        isActivePatron: membership.isActivePatron,
        lastSyncedAt: new Date(),
      };
      await this.prisma.membership.upsert({
        where: { userId_creatorId: { userId, creatorId: creator.id } },
        create: { userId, creatorId: creator.id, ...state },
        update: state,
      });
      syncedCreatorIds.push(creator.id);
    }

    await this.deactivateAbsent(userId, syncedCreatorIds, options);

    // Whatever was owed is settled — but only by a sync that saw everything. A webhook speaks
    // for one campaign, so clearing on that would call the debt paid on the strength of a
    // partial view and strand a first-time reader with whatever that one campaign happened to
    // say. Same distinction `deactivateAbsent` draws just above, for the same reason.
    if (!options.onlyCampaignIds) {
      await this.prisma.user.updateMany({
        where: { id: userId, membershipsSyncPending: true },
        data: { membershipsSyncPending: false },
      });
    }
  }

  /**
   * Patreon reports current memberships only, so a lapsed one simply stops appearing. Without
   * this the sync could grant access but never revoke it.
   */
  private async deactivateAbsent(
    userId: string,
    syncedCreatorIds: string[],
    options: ApplyIdentityOptions,
  ): Promise<void> {
    const scopedCreatorIds = options.onlyCampaignIds
      ? (
          await this.prisma.creator.findMany({
            where: { patreonCampaignId: { in: options.onlyCampaignIds } },
            select: { id: true },
          })
        ).map((creator) => creator.id)
      : null;

    await this.prisma.membership.updateMany({
      where: {
        userId,
        creatorId: scopedCreatorIds
          ? { in: scopedCreatorIds, notIn: syncedCreatorIds }
          : { notIn: syncedCreatorIds },
      },
      data: { isActivePatron: false, currentTierId: null, lastSyncedAt: new Date() },
    });
  }
}
