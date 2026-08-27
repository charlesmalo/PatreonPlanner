import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE } from './session.cookie';
import { SessionService } from './session.service';

export interface CurrentUserPayload {
  id: string;
  patreonUserId: string;
  fullName: string | null;
  avatarUrl: string | null;
  /**
   * A rendering hint, and a `User` property rather than a `(user, creator)` one — Amendment A.1
   * keeps premium out of `can(capability, viewer, policy)` entirely, so it is deliberately absent
   * from `Viewer`. Every endpoint behind a premium control checks again and refuses regardless.
   */
  isPremium: boolean;
}

type AuthenticatedRequest = Request & { currentUser?: CurrentUserPayload };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException();

    const userId = await this.sessions.resolve(token);
    if (!userId) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      // Explicit select rather than the whole row: the encrypted token columns must never
      // reach a handler, where returning `user` directly would serialize them into a response.
      select: {
        id: true,
        patreonUserId: true,
        fullName: true,
        avatarUrl: true,
        premiumUntil: true,
      },
    });
    // A session can outlive its user. Deleting the row is then enough to lock the holder out,
    // without having to hunt down their sessions.
    if (!user) throw new UnauthorizedException();

    const { premiumUntil, ...rest } = user;
    // Derived here rather than sent raw: a date on the wire invites a client to compare it
    // against its own clock, and a device with a wrong clock would grant itself premium.
    request.currentUser = {
      ...rest,
      isPremium: premiumUntil !== null && premiumUntil > new Date(),
    };
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().currentUser as CurrentUserPayload,
);
