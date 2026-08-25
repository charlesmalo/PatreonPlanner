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
import { hasPermission, type StaffPermissionValue } from './permissions';
import { REQUIRED_CAPABILITY } from './require-capability.decorator';
import { REQUIRED_PERMISSION } from './require-permission.decorator';

export interface ResolvedCreator {
  id: string;
  slug: string;
  displayName: string;
  /** Design §7's toggle, carried here so the board read model does not re-query the policy. */
  hidePendingFromPublic: boolean;
  allowVoteRatchet: boolean;
  allowAnonymousTickets: boolean;
  allowReactions: boolean;
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
    // getAllAndOverride so a controller-level decorator is honoured, and a hard failure when
    // absent: can(undefined, ...) returns true for staff, so a route that forgot the decorator
    // would silently be open to them.
    const capability = this.reflector.getAllAndOverride<Capability>(REQUIRED_CAPABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!capability) {
      throw new Error('CreatorAccessGuard used without @RequireCapability');
    }
    const request = context.switchToHttp().getRequest<CreatorRequest>();

    const creator = await this.loadCreator(request);
    // Resolved before the viewer, so an unauthorized caller never triggers the membership and
    // staff queries. Note this does NOT hide existence: a missing creator 404s while a gated
    // one 401s, so one request still distinguishes them. Slugs are public by design, but do not
    // build anything on the assumption that they are secret.
    if (!creator) throw new NotFoundException();

    const userId = await this.resolveUser(request);
    const viewer = await this.loadViewer(creator.id, userId);
    const policy: Policy = {
      // Fail closed. A creator without a policy row is a data-integrity fault, not consent to
      // publish; claiming always creates one, so this default should be unreachable.
      viewVisibility: creator.policy?.viewVisibility ?? 'SUBSCRIBERS_ONLY',
      submitMinTierAmountCents: creator.policy?.submitMinTier?.amountCents ?? null,
      upvoteMinTierAmountCents: creator.policy?.upvoteMinTier?.amountCents ?? null,
    };

    if (!can(capability, viewer, policy)) {
      // 401 when logging in could fix it, 403 when it could not — so a caller is never told to
      // authenticate for something authentication will not grant.
      throw viewer.isAuthenticated ? new ForbiddenException() : new UnauthorizedException();
    }

    // The finer half. Being staff got them this far; this decides whether *this* action is
    // theirs. Always a 403: reaching here means they are authenticated staff, so logging in
    // again would not help.
    const permission = this.reflector.getAllAndOverride<StaffPermissionValue | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (permission && !hasPermission(viewer, permission)) {
      throw new ForbiddenException();
    }

    request.creator = {
      id: creator.id,
      slug: creator.slug,
      displayName: creator.displayName,
      // Fail closed for the same reason viewVisibility does: a creator with no policy row is a
      // data-integrity fault, and the safe reading of a missing toggle is "hide".
      hidePendingFromPublic: creator.policy?.hidePendingFromPublic ?? true,
      // Defaults to off when a board somehow has no policy row, matching how the rest of this
      // resolver fails closed.
      allowVoteRatchet: creator.policy?.allowVoteRatchet ?? false,
      // Fails closed like the rest of this resolver: a board with no policy row does not take
      // messages from strangers.
      allowAnonymousTickets: creator.policy?.allowAnonymousTickets ?? false,
      allowReactions: creator.policy?.allowReactions ?? false,
    };
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
            hidePendingFromPublic: true,
            allowVoteRatchet: true,
            allowAnonymousTickets: true,
            allowReactions: true,
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
        userId: null,
        isAuthenticated: false,
        isActivePatron: false,
        pledgeAmountCents: null,
        staffRole: null,
        permissions: [],
      };
    }
    const [user, membership, staff] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
      this.prisma.membership.findUnique({
        where: { userId_creatorId: { userId, creatorId } },
        select: { isActivePatron: true, amountCents: true },
      }),
      this.prisma.creatorStaff.findUnique({
        where: { creatorId_userId: { creatorId, userId } },
        // The role, not merely existence: managing staff is the owner's alone. The permission
        // set comes with it, so a moderated request costs no extra query to answer "and may
        // they do this in particular".
        select: { role: true, permissions: true },
      }),
    ]);
    // A session can outlive its user. Falling back to anonymous keeps deleting the row
    // sufficient to lock someone out here too, matching SessionGuard.
    if (!user) {
      return {
        userId: null,
        isAuthenticated: false,
        isActivePatron: false,
        pledgeAmountCents: null,
        staffRole: null,
        permissions: [],
      };
    }
    return {
      userId,
      isAuthenticated: true,
      isActivePatron: membership?.isActivePatron ?? false,
      // Membership.amountCents is Patreon's entitled amount — the pledge actually held. The
      // mirrored Tier's price would be wrong whenever a tier exists on Patreon but has not been
      // imported here, denying a creator's highest-paying patrons.
      pledgeAmountCents: membership?.amountCents ?? null,
      staffRole: staff?.role ?? null,
      permissions: staff?.permissions ?? [],
    };
  }
}

/** The viewer the guard resolved, so a handler can report capabilities without redoing the work. */
export const CurrentViewer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Viewer =>
    context.switchToHttp().getRequest<CreatorRequest>().viewer as Viewer,
);

export const CurrentCreator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedCreator =>
    context.switchToHttp().getRequest<CreatorRequest>().creator as ResolvedCreator,
);
