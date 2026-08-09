import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookSignatureService } from './webhook-signature.service';

export interface WebhookCreator {
  id: string;
  patreonCampaignId: string;
}

type WebhookRequest = RawBodyRequest<Request> & { webhookCreator?: WebhookCreator };

/**
 * Applied at the controller level so the signature check covers exactly the routes the CSRF
 * middleware exempts. Leaving verification in one handler body meant a second route added to
 * this controller would be both unauthenticated and CSRF-exempt.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(
    private readonly signatures: WebhookSignatureService,
    private readonly encryption: EncryptionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebhookRequest>();
    const { creatorId } = request.params as { creatorId?: string };
    if (!creatorId || !request.rawBody) throw new UnauthorizedException();

    const creator = await this.prisma.creator.findUnique({
      where: { id: creatorId },
      select: { id: true, patreonCampaignId: true, webhookSecretEncrypted: true },
    });
    // Everything below is the same generic 401: a caller must not learn whether the creator
    // exists, whether a secret is registered, or which part of the signature was wrong.
    if (!creator?.webhookSecretEncrypted) throw new UnauthorizedException();

    const signature = request.header('x-patreon-signature');
    const secret = this.encryption.decrypt(creator.webhookSecretEncrypted);
    if (!this.signatures.verify(request.rawBody, signature, secret)) {
      throw new UnauthorizedException();
    }

    request.webhookCreator = { id: creator.id, patreonCampaignId: creator.patreonCampaignId };
    return true;
  }
}

export const VerifiedCreator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WebhookCreator =>
    context.switchToHttp().getRequest<WebhookRequest>().webhookCreator as WebhookCreator,
);
