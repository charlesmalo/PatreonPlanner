import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_BYTES = 32;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** An unbounded generator is an unbounded set of live credentials. */
export const MAX_PENDING_INVITES = 10;

/**
 * Every failure to redeem answers the same way. Distinguishing "expired" from "already used"
 * from "never existed" turns the endpoint into a token oracle.
 */
const REDEEM_FAILURE = 'That invitation is not valid';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the plaintext token exactly once; only its hash is stored, so a database read cannot
   * recover a live invite. The same rule the session token follows, for the same reason.
   */
  async createInvite(creatorId: string, invitedByUserId: string) {
    const pending = await this.prisma.staffInvite.count({
      where: this.pendingWhere(creatorId),
    });
    if (pending >= MAX_PENDING_INVITES) {
      throw new ConflictException('Too many outstanding invitations');
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.prisma.staffInvite.create({
      data: {
        creatorId,
        tokenHash: hashToken(token),
        // Never OWNER: ownership is set at claim time, and transferring it is a different
        // operation with different stakes. The check constraint says so too.
        role: 'MOD',
        invitedByUserId,
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  async list(creatorId: string) {
    const [members, invites] = await Promise.all([
      this.prisma.creatorStaff.findMany({
        where: { creatorId },
        select: {
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { fullName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.staffInvite.findMany({
        where: this.pendingWhere(creatorId),
        // Deliberately no tokenHash: it is not a secret worth leaking the shape of, and nothing
        // a client can do with it is legitimate.
        select: { id: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      members: members.map(({ user, ...member }) => ({
        ...member,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
      })),
      invites,
    };
  }

  async revokeInvite(creatorId: string, inviteId: string): Promise<void> {
    // Scoped by creatorId: an invite id alone says nothing about which board it belongs to.
    const { count } = await this.prisma.staffInvite.updateMany({
      where: { id: inviteId, creatorId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException();
  }

  /**
   * Redeems an invite for the signed-in user. Consent is the point: nobody becomes a moderator
   * without doing this themselves.
   */
  async acceptInvite(token: string, userId: string) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        creatorId: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        creator: { select: { slug: true, displayName: true } },
      },
    });
    if (
      !invite ||
      invite.acceptedAt !== null ||
      invite.revokedAt !== null ||
      invite.expiresAt <= new Date()
    ) {
      throw new NotFoundException(REDEEM_FAILURE);
    }

    const existing = await this.prisma.creatorStaff.findUnique({
      where: { creatorId_userId: { creatorId: invite.creatorId, userId } },
      select: { role: true },
    });

    return this.prisma.$transaction(async (tx) => {
      // Conditional on it still being unspent: two people following the same link at once would
      // otherwise both be appointed, which is not what single-use means.
      const { count } = await tx.staffInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date(), acceptedByUserId: userId },
      });
      if (count === 0) throw new NotFoundException(REDEEM_FAILURE);

      // Never demote. The composite unique makes an upsert an update, and an unguarded one
      // would strip a creator of their own board for following their own link.
      if (!existing) {
        await tx.creatorStaff.create({
          data: { creatorId: invite.creatorId, userId, role: invite.role, assignedByUserId: null },
        });
      }

      return {
        creator: invite.creator,
        role: existing?.role ?? invite.role,
      };
    });
  }

  async removeMember(creatorId: string, userId: string): Promise<void> {
    const member = await this.prisma.creatorStaff.findUnique({
      where: { creatorId_userId: { creatorId, userId } },
      select: { id: true, role: true },
    });
    if (!member) throw new NotFoundException();

    if (member.role === 'OWNER') {
      const owners = await this.prisma.creatorStaff.count({
        where: { creatorId, role: 'OWNER' },
      });
      // A board with no owner is unadministrable, and no endpoint can put one back.
      if (owners <= 1) throw new ConflictException('A creator must keep an owner');
    }

    await this.prisma.creatorStaff.delete({ where: { id: member.id } });
  }

  /** Live, redeemable invitations: not spent, not revoked, not expired. */
  private pendingWhere(creatorId: string) {
    return {
      creatorId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    };
  }
}
