import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The identity of a page, with the parts that only say *where it was found* removed.
 *
 * Only for platforms whose identity is genuinely stable: Netflix uses the same numeric id on
 * every TLD, a YouTube id is global, a Crunchyroll series id is the same in every region. An
 * unknown domain is left exactly as it arrived — guessing at a shape we do not know would
 * silently merge two different pages, which is worse than keeping two rows for one.
 */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not parseable, so it is its own identity. The DTO already rejects a non-http(s) URL.
    return raw.trim().toLowerCase();
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  // Netflix: /title/<id> is the whole identity, wherever the country prefix or TLD land.
  if (/(^|\.)netflix\.[a-z.]+$/.test(host)) {
    const id = url.pathname.match(/\/title\/(\d+)/)?.[1];
    if (id) return `netflix:${id}`;
  }

  // YouTube: youtu.be/<id> and youtube.com/watch?v=<id> are the same video, and everything else
  // on the URL is a timestamp or a referrer.
  if (/(^|\.)youtube\.[a-z.]+$/.test(host) || host === 'youtu.be') {
    const id =
      host === 'youtu.be'
        ? url.pathname.slice(1).split('/')[0]
        : (url.searchParams.get('v') ?? url.pathname.match(/\/(?:embed|shorts)\/([^/]+)/)?.[1]);
    if (id) return `youtube:${id}`;
  }

  // Crunchyroll: the series id is stable; the locale segment and the slug are decoration.
  if (/(^|\.)crunchyroll\.[a-z.]+$/.test(host)) {
    const id = url.pathname.match(/\/series\/([^/]+)/)?.[1];
    if (id) return `crunchyroll:${id}`;
  }

  // Everything else compared as given, minus a trailing slash and the fragment — neither of
  // which ever identifies a different page.
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${path}${url.search}`.toLowerCase();
}

/** Who is asking, for the parts of an entry that are not the same for everyone. */
export type LinkViewer = { userId: string | null; isStaff: boolean };

/**
 * Which links this viewer may see: published ones, plus candidates they submitted themselves,
 * plus every candidate if they are staff.
 *
 * Their own candidate is not an endorsement — it is the thing they just typed — and hiding it
 * makes a submitted link look like it was swallowed. The `userId === null` branch is load-bearing:
 * `submittedByUserId: null` is a real stored value, so an unguarded equality would hand every
 * anonymous candidate on the board to every signed-out reader.
 */
export function visibleLinks(viewer: LinkViewer) {
  const where = viewer.isStaff
    ? {}
    : viewer.userId === null
      ? { status: 'PUBLISHED' as const }
      : {
          OR: [{ status: 'PUBLISHED' as const }, { submittedByUserId: viewer.userId }],
        };
  return {
    where,
    // `status` rides along so one presenter can partition whatever this returned.
    select: { id: true, url: true, label: true, status: true, isPreferred: true },
    orderBy: [{ isPreferred: 'desc' as const }, { createdAt: 'asc' as const }],
  };
}

@Injectable()
export class LinksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records URLs against an entry.
   *
   * Staff publish immediately — someone who can already edit the board's content does not need
   * to approve their own URL. Everyone else queues a candidate, because otherwise submitting a
   * duplicate is a way to attach a link to any card on any public board, where it renders with
   * the creator's implicit endorsement.
   */
  async contribute(
    tx: Prisma.TransactionClient | PrismaService,
    recommendationId: string,
    userId: string | null,
    isStaff: boolean,
    links: Array<{ url: string; label?: string }>,
  ) {
    const readBack = () => this.linksFor(tx, recommendationId, { userId, isStaff });
    if (links.length === 0) return readBack();

    // A creator who has decided where to watch something does not want a queue of alternatives
    // waiting behind that decision.
    const locked = await tx.recommendationLink.findFirst({
      where: { recommendationId, isPreferred: true },
      select: { id: true },
    });
    if (locked && !isStaff) return readBack();

    await tx.recommendationLink.createMany({
      data: links.map((link) => ({
        recommendationId,
        url: link.url,
        label: link.label ?? null,
        canonicalUrl: canonicalUrl(link.url),
        submittedByUserId: userId,
        status: isStaff ? ('PUBLISHED' as const) : ('CANDIDATE' as const),
      })),
      // The same page submitted by four people is one candidate, not four.
      skipDuplicates: true,
    });

    // Returned rather than left for the caller to fetch: the caller's row was selected before
    // any of this ran, and three of them read it back stale before this returned anything.
    return readBack();
  }

  /**
   * The links on an entry that a viewer may see.
   *
   * Composed with AND rather than spread: `visibleLinks` returns an `OR` for a signed-in reader,
   * and spreading it beside another key is how a visibility filter gets silently overwritten.
   */
  private linksFor(
    tx: Prisma.TransactionClient | PrismaService,
    recommendationId: string,
    viewer: LinkViewer,
  ) {
    const visible = visibleLinks(viewer);
    return tx.recommendationLink.findMany({
      where: { AND: [{ recommendationId }, visible.where] },
      select: visible.select,
      orderBy: visible.orderBy,
    });
  }

  /** Publish, or mark preferred. Scoped by creator — a link id says nothing about which board. */
  async decide(
    creatorId: string,
    id: string,
    change: { status?: 'CANDIDATE' | 'PUBLISHED'; isPreferred?: boolean },
  ) {
    const link = await this.findOnBoard(creatorId, id);

    return this.prisma.$transaction(async (tx) => {
      if (change.isPreferred) {
        // One preferred link per entry: a second would make "preferred" mean nothing.
        await tx.recommendationLink.updateMany({
          where: { recommendationId: link.recommendationId, isPreferred: true },
          data: { isPreferred: false },
        });
      }
      return tx.recommendationLink.update({
        where: { id: link.id },
        data: {
          ...(change.status ? { status: change.status } : {}),
          ...(change.isPreferred === undefined ? {} : { isPreferred: change.isPreferred }),
          // A hidden favourite is no favourite: preferring a candidate publishes it.
          ...(change.isPreferred ? { status: 'PUBLISHED' as const } : {}),
        },
        select: { id: true, url: true, status: true, isPreferred: true },
      });
    });
  }

  async discard(creatorId: string, id: string): Promise<void> {
    const link = await this.findOnBoard(creatorId, id);
    await this.prisma.recommendationLink.delete({ where: { id: link.id } });
  }

  private async findOnBoard(creatorId: string, id: string) {
    const link = await this.prisma.recommendationLink.findFirst({
      where: { id, recommendation: { creatorId } },
      select: { id: true, recommendationId: true },
    });
    if (!link) throw new NotFoundException();
    return link;
  }
}
