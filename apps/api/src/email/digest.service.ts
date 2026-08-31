import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailSender } from './email-sender';
import { UnsubscribeTokenService } from './unsubscribe-token.service';

/** Small: each one is an email, and the tick is shared with seven other jobs. */
export const DIGEST_BATCH = 50;

interface DigestLine {
  title: string;
  status: string;
  creatorName: string;
  creatorSlug: string;
  recommendationId: string;
}

/**
 * One email a day, for the readers who asked for one.
 *
 * It reads the notification rows that already exist rather than being a second source of events.
 * Those rows were filtered at fan-out by visibility, by the columns the reader chose, by their
 * themes and by what they follow — so the digest inherits every one of those decisions and there
 * is no second answer to "may they see this" to keep in step with the first.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: EmailSender,
    private readonly tokens: UnsubscribeTokenService,
  ) {}

  async runOnce(): Promise<number> {
    const readers = await this.prisma.user.findMany({
      // Opted in, and reachable. An address is nullable — Patreon does not always give one.
      where: { emailDigest: true, email: { not: null } },
      orderBy: [{ lastDigestAt: { sort: 'asc', nulls: 'first' } }],
      select: { id: true, email: true, lastDigestAt: true },
      take: DIGEST_BATCH,
    });

    let sent = 0;
    for (const reader of readers) {
      try {
        if (await this.sendTo(reader)) sent += 1;
      } catch (error) {
        // One unreachable address must not strand everybody else's digest behind it. The
        // watermark is untouched, so tomorrow's attempt still carries today's news.
        this.logger.warn(`Digest for ${reader.id} failed: ${String(error)}`);
      }
    }
    return sent;
  }

  private async sendTo(reader: {
    id: string;
    email: string | null;
    lastDigestAt: Date | null;
  }): Promise<boolean> {
    const since = reader.lastDigestAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.notification.findMany({
      where: { userId: reader.id, type: 'ENTRY_MOVED', createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { payload: true },
    });

    // A daily email saying nothing happened is how people unsubscribe. The watermark stays put
    // too, so a quiet week does not silently swallow the day something finally moves.
    if (rows.length === 0) return false;

    const lines = rows.map((row) => row.payload as unknown as DigestLine);
    await this.sender.send({
      to: reader.email as string,
      subject: subjectFor(lines),
      text: bodyFor(lines, this.tokens.linkFor(reader.id)),
    });

    // Only now. Moving it before the send would lose a day's news to a provider outage.
    await this.prisma.user.update({
      where: { id: reader.id },
      data: { lastDigestAt: new Date() },
    });
    return true;
  }
}

function subjectFor(lines: DigestLine[]): string {
  const boards = new Set(lines.map((line) => line.creatorName));
  const board = boards.size === 1 ? [...boards][0] : `${boards.size} boards`;
  return lines.length === 1
    ? `${lines[0].title} on ${board}`
    : `${lines.length} updates on ${board}`;
}

/**
 * Plain text on purpose.
 *
 * A digest is a list of things that happened with links to them. HTML would need a template
 * system and a preview surface to be worth having, and lands in spam more often besides.
 */
function bodyFor(lines: DigestLine[], unsubscribe: string): string {
  const body = lines
    .map((line) => `• ${line.title} — ${line.status.toLowerCase()} on ${line.creatorName}`)
    .join('\n');
  return `${body}\n\nStop receiving these: ${unsubscribe}\n`;
}
