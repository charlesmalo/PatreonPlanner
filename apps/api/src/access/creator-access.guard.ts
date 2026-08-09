import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE } from '../session/session.cookie';
import { SessionService } from '../session/session.service';
import { Capability, Policy, Viewer, can } from './capability';
import { REQUIRED_CAPABILITY } from './require-capability.decorator';

export interface ResolvedCreator {
  id: string;
  slug: string;
  displayName: string;
}

type CreatorRequest = Request & { creator?: ResolvedCreator; viewer?: Viewer };

@Injectable()
export class CreatorAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability = this.reflector.get<Capability>(REQUIRED_CAPABILITY, context.getHandler());
    const request = context.switchToHttp().getRequest<CreatorRequest>();

    const creator = await this.loadCreator(request);
    // 404 before any authorization work, so an unauthenticated probe cannot distinguish a
    // private creator from one that does not exist.
    if (!creator) throw new NotFoundException();

    const userId = await this.resolveUser(request);
    const viewer = await this.loadViewer(creator.id, userId);
    const policy: Policy = {
      viewVisibility: creator.policy?.viewVisibility ?? 'PUBLIC',
      submitMinTierAmountCents: creator.policy?.submitMinTier?.amountCents ?? null,
      upvoteMinTierAmountCents: creator.policy?.upvoteMinTier?.amountCents ?? null,
    };

    if (!can(capability, viewer, policy)) {
      // 401 when logging in could fix it, 403 when it could not — so a caller is never told to
      // authenticate for something authentication will not grant.
      throw viewer.isAuthenticated ? new ForbiddenException() : new UnauthorizedException();
    }

    request.creator = { id: creator.id, slug: creator.slug, displayName: creator.displayName };
    request.viewer = viewer;
    return true;
  }

  private async loadCreator(request: CreatorRequest) {
    const { slug, creatorId } = request.params as { slug?: string; creatorId?: string };
    if (!slug && !creatorId) throw new NotFoundException();
    return this.prisma.creator.findUnique({
      where: slug ? { slug } : { id: creatorId },
      select: {
        id: true,
        slug: true,
        displayName: true,
        policy: {
          select: {
            viewVisibility: true,
            submitMinTier: { select: { amountCents: true } },
            upvoteMinTier: { select: { amountCents: true } },
          },
        },
      },
    });
  }

  private async resolveUser(request: CreatorRequest): Promise<string | null> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    return this.sessions.resolve(token);
  }

  /**
   * Membership is looked up per creator, so a pledge to one creator never unlocks another —
   * the composite key makes that structural rather than a filter someone could omit.
   */
  private async loadViewer(creatorId: string, userId: string | null): Promise<Viewer> {
    if (!userId) {
      return {
        isAuthenticated: false,
        isActivePatron: false,
        tierAmountCents: null,
        isStaff: false,
      };
    }
    const [user, membership, staff] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
      this.prisma.membership.findUnique({
        where: { userId_creatorId: { userId, creatorId } },
        select: { isActivePatron: true, currentTier: { select: { amountCents: true } } },
      }),
      this.prisma.creatorStaff.findUnique({
        where: { creatorId_userId: { creatorId, userId } },
        select: { id: true },
      }),
    ]);
    // A session can outlive its user. Falling back to anonymous keeps deleting the row
    // sufficient to lock someone out here too, matching SessionGuard.
    if (!user) {
      return {
        isAuthenticated: false,
        isActivePatron: false,
        tierAmountCents: null,
        isStaff: false,
      };
    }
    return {
      isAuthenticated: true,
      isActivePatron: membership?.isActivePatron ?? false,
      tierAmountCents: membership?.currentTier?.amountCents ?? null,
      isStaff: staff !== null,
    };
  }
}

export const CurrentCreator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedCreator =>
    context.switchToHttp().getRequest<CreatorRequest>().creator as ResolvedCreator,
);
