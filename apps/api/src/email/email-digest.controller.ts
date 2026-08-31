import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { PrismaService } from '../prisma/prisma.service';

export class SetEmailDigestDto {
  @IsBoolean()
  enabled!: boolean;
}

/**
 * Turning the daily email on and off from inside the app.
 *
 * Not creator-scoped: one digest covers every board a reader follows, so the setting is theirs
 * rather than a board's. The unsubscribe link does the same thing without a session, for readers
 * who are in their mail client rather than here.
 */
@Controller('me/email-digest')
@UseGuards(SessionGuard)
export class EmailDigestController {
  constructor(private readonly prisma: PrismaService) {}

  @Put()
  async set(@CurrentUser() user: CurrentUserPayload, @Body() dto: SetEmailDigestDto) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailDigest: dto.enabled },
      select: { emailDigest: true, email: true },
    });
    return {
      emailDigest: updated.emailDigest,
      // Patreon does not always give an address. Saying so beats a switch that reads as on and
      // silently sends nothing.
      deliverable: updated.email !== null,
    };
  }
}
