import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokenService } from '../patreon/patreon-token.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';
import { slugify } from './slug';

const POLICY_FIELDS = {
  viewVisibility: true,
  submitMinTierId: true,
  upvoteMinTierId: true,
  hidePendingFromPublic: true,
} as const;

@Injectable()
export class CreatorsService {
  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly tokens: PatreonTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async claim(
    userId: string,
    dto: ClaimCreatorDto,
  ): Promise<{ id: string; slug: string; displayName: string }> {
    let owned;
    try {
      owned = await this.patreon.fetchOwnedCampaigns(await this.tokens.getAccessToken(userId));
    } catch {
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
