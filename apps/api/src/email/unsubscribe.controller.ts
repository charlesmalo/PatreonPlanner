import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UnsubscribeTokenService } from './unsubscribe-token.service';

/**
 * Stopping the digest, from a mail client, with no session.
 *
 * Unauthenticated by necessity and authorised entirely by the signature — which is why the token
 * is an HMAC rather than the user id. A bare id here would let anybody unsubscribe anybody.
 *
 * A GET, because that is what a mail client follows. It is not idempotency-neutral, which a GET
 * is meant to be, but the alternative is a link that does nothing until the reader finds a button
 * — and the action it performs only ever reduces what we send them.
 */
@Controller('email/unsubscribe')
export class UnsubscribeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: UnsubscribeTokenService,
  ) {}

  @Get()
  async unsubscribe(@Query('u') userId?: string, @Query('t') token?: string) {
    if (!userId || !token || !this.tokens.verify(userId, token)) {
      // One answer for a bad signature and for a user that does not exist. Distinguishing them
      // turns this into a way to test whether an id is real.
      throw new BadRequestException('That link is not valid');
    }

    // updateMany rather than update: a token for a deleted account is not an error worth showing
    // somebody who is trying to stop receiving mail.
    await this.prisma.user.updateMany({ where: { id: userId }, data: { emailDigest: false } });
    return { ok: true };
  }
}
