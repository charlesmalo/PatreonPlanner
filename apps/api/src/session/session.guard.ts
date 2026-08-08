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
      select: { id: true, patreonUserId: true, fullName: true, avatarUrl: true },
    });
    // A session can outlive its user. Deleting the row is then enough to lock the holder out,
    // without having to hunt down their sessions.
    if (!user) throw new UnauthorizedException();

    request.currentUser = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().currentUser as CurrentUserPayload,
);
