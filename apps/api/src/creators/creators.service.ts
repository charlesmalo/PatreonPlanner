import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Policy } from '../access/capability';
import { EncryptionService } from '../crypto/encryption.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokenService } from '../patreon/patreon-token.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';
import { slugify } from './slug';

/**
 * Everything a creator decides about their own board.
 *
 * The settings page renders from exactly this, so a column added to `CreatorPolicy` and not added
 * here is a setting nobody can see or change — which is what the four below had been.
 */
const POLICY_FIELDS = {
  viewVisibility: true,
  submitMinTierId: true,
  upvoteMinTierId: true,
  hidePendingFromPublic: true,
  allowAnonymousTickets: true,
  allowReactions: true,
  acceptsCarryOver: true,
  allowVoteRatchet: true,
} as const;

@Injectable()
export class CreatorsService {
  private readonly logger = new Logger(CreatorsService.name);

  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly tokens: PatreonTokenService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * The campaigns this account could turn into a board.
   *
   * Exposes nothing `claim` did not already reach for: it fetches the same list to verify
   * ownership and throws it away. Without this there is no way to learn a `patreonCampaignId`,
   * and nobody knows their own — which is why `claim` was unreachable from the app entirely.
   *
   * Already-claimed campaigns are returned rather than filtered out, with the slug of the board
   * they became. Filtering would leave a creator staring at a short list wondering where their
   * campaign went; the only other way to find out is to press claim and read a 409.
   */
  async listClaimable(userId: string): Promise<{
    items: Array<{
      patreonCampaignId: string;
      displayName: string;
      claimed: boolean;
      slug: string | null;
    }>;
  }> {
    let owned;
    try {
      owned = await this.patreon.fetchOwnedCampaigns(await this.tokens.getAccessToken(userId));
    } catch (error) {
      this.logger.warn(
        `Listing claimable campaigns failed for user ${userId}: ${(error as Error).message}`,
      );
      // Never an empty list. "You own no campaigns" and "Patreon could not be reached" are
      // different statements, and answering the first when the second is true sends a creator
      // away believing they have nothing to claim.
      throw new BadGatewayException('Could not reach Patreon');
    }

    const claimed = await this.prisma.creator.findMany({
      where: { patreonCampaignId: { in: owned.map((c) => c.campaignId) } },
      select: { patreonCampaignId: true, slug: true },
    });
    const bySlug = new Map(claimed.map((c) => [c.patreonCampaignId, c.slug]));

    return {
      items: owned.map((campaign) => ({
        patreonCampaignId: campaign.campaignId,
        displayName: campaign.displayName,
        claimed: bySlug.has(campaign.campaignId),
        slug: bySlug.get(campaign.campaignId) ?? null,
      })),
    };
  }

  async claim(
    userId: string,
    dto: ClaimCreatorDto,
  ): Promise<{ id: string; slug: string; displayName: string }> {
    let owned;
    try {
      owned = await this.patreon.fetchOwnedCampaigns(await this.tokens.getAccessToken(userId));
    } catch (error) {
      // The likeliest cause is a session predating the `campaigns` scope, which is
      // indistinguishable from an outage in the response — so it has to be diagnosable from the
      // logs. Message only, never the token.
      this.logger.warn(
        `Claim failed reaching Patreon for user ${userId}: ${(error as Error).message}`,
      );
      // An upstream failure is not the caller's fault, and must not be reported as though the
      // ownership check ran and rejected them.
      throw new BadGatewayException('Could not reach Patreon');
    }

    const campaign = owned.find((c) => c.campaignId === dto.patreonCampaignId);
    // Patreon returns only campaigns this token's owner controls, so absence is the proof.
    if (!campaign) throw new ForbiddenException('Campaign not owned by this account');

    const existing = await this.prisma.creator.findUnique({
      where: { patreonCampaignId: campaign.campaignId },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Campaign already claimed');

    try {
      return await this.prisma.$transaction(async (tx) => {
        return tx.creator.create({
          data: {
            patreonCampaignId: campaign.campaignId,
            ownerUserId: userId,
            displayName: campaign.displayName,
            slug: await this.uniqueSlug(tx, slugify(campaign.displayName)),
            baseUrl: dto.baseUrl ?? null,
            tiers: { create: campaign.tiers },
            // Design §3: moderation power derives only from a CreatorStaff row, so the owner
            // needs one from the outset rather than being special-cased at every check.
            staff: { create: { userId, role: 'OWNER' } },
            policy: { create: {} },
          },
          select: { id: true, slug: true, displayName: true },
        });
      });
    } catch (error) {
      // Two claims racing past the check above collide on the unique constraint instead.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Campaign already claimed');
      }
      throw error;
    }
  }

  async publicProfile(creatorId: string) {
    return this.prisma.creator.findUniqueOrThrow({
      where: { id: creatorId },
      // Explicit select: ownerUserId and patreonCampaignId are internal and must never be
      // serialized into a public response.
      select: {
        id: true,
        slug: true,
        displayName: true,
        baseUrl: true,
        tiers: {
          select: { id: true, title: true, amountCents: true, order: true },
          orderBy: { amountCents: 'asc' },
        },
      },
    });
  }

  /** The policy in the shape the resolver consumes, with the same fail-closed default as the guard. */
  async policyForResolver(creatorId: string): Promise<Policy> {
    const policy = await this.prisma.creatorPolicy.findUnique({
      where: { creatorId },
      select: {
        viewVisibility: true,
        submitMinTier: { select: { amountCents: true } },
        upvoteMinTier: { select: { amountCents: true } },
      },
    });
    return {
      viewVisibility: policy?.viewVisibility ?? 'SUBSCRIBERS_ONLY',
      submitMinTierAmountCents: policy?.submitMinTier?.amountCents ?? null,
      upvoteMinTierAmountCents: policy?.upvoteMinTier?.amountCents ?? null,
    };
  }

  async getPolicy(creatorId: string) {
    return this.prisma.creatorPolicy.findUniqueOrThrow({
      where: { creatorId },
      select: POLICY_FIELDS,
    });
  }

  async updatePolicy(creatorId: string, dto: UpdatePolicyDto) {
    for (const tierId of [dto.submitMinTierId, dto.upvoteMinTierId]) {
      if (!tierId) continue;
      const tier = await this.prisma.tier.findFirst({
        where: { id: tierId, creatorId },
        select: { id: true },
      });
      // A tier belonging to another creator would gate this board on something nobody who
      // pledges here can ever hold.
      if (!tier) throw new BadRequestException('Tier does not belong to this creator');
    }
    return this.prisma.creatorPolicy.update({
      where: { creatorId },
      data: dto,
      select: POLICY_FIELDS,
    });
  }

  /**
   * Stores the creator's own Patreon webhook secret, encrypted like the OAuth tokens. Per
   * creator rather than global: Patreon issues one secret per webhook, and a shared secret
   * would let any holder forge membership events for every other creator.
   */
  async setWebhookSecret(creatorId: string, secret: string): Promise<{ configured: true }> {
    await this.prisma.creator.update({
      where: { id: creatorId },
      data: { webhookSecretEncrypted: this.encryption.encrypt(secret) },
    });
    // Never echo it back.
    return { configured: true };
  }

  private async uniqueSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
    if (!(await tx.creator.findUnique({ where: { slug: base }, select: { id: true } }))) {
      return base;
    }
    // Random rather than an incrementing counter: a counter would leak how many creators share
    // a name, and computing it needs a scan.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      if (!(await tx.creator.findUnique({ where: { slug: candidate }, select: { id: true } }))) {
        return candidate;
      }
    }
    throw new ConflictException('Could not allocate a slug');
  }
}
