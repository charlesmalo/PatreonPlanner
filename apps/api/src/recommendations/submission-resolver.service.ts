import { BadRequestException, Injectable } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { normalizeTitle } from './normalize-title';

/**
 * Turning what a client typed into rows the board can trust.
 *
 * Separate from the submission flow because it is the only part that talks to TMDB, and it is
 * the part with an answer of its own: a title either resolves to a catalogue row or it does not,
 * regardless of who is asking or whether they are allowed to.
 */

/** Which canonical media type each binding content class resolves against. */
const MEDIA_TYPES: Record<'MOVIE' | 'SHOW' | 'FRANCHISE', MediaType> = {
  MOVIE: 'MOVIE',
  SHOW: 'TV',
  FRANCHISE: 'COLLECTION',
};

@Injectable()
export class SubmissionResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Confirms a mainstream submission against the catalogue and persists the canonical title, so
   * the stored name is TMDB's rather than whatever the client typed. Returns null for external
   * links, which have no canonical identity.
   */
  async resolveTitle(dto: SubmitRecommendationDto) {
    // Items belong to a watch order and nothing else; accepting them elsewhere would store rows
    // no read model ever surfaces.
    if (dto.type !== 'WATCH_ORDER' && dto.items !== undefined) {
      throw new BadRequestException('Only a watch order can carry items');
    }
    if (dto.type === 'EXTERNAL_LINK' || dto.type === 'WATCH_ORDER') {
      // Whitelisting keeps declared properties, so without this a client could attach a binding
      // that never passed the catalogue check.
      if (dto.tmdbId !== undefined) {
        throw new BadRequestException('This type cannot carry a catalogue id');
      }
      return null;
    }
    // The canonical name wins, so a supplied one is never used — and silently ignoring it lets a
    // submitter believe they named the entry. Symmetrical with the id check above.
    if (dto.customTitle !== undefined) {
      throw new BadRequestException('A catalogue-bound entry takes its title from the catalogue');
    }
    // A franchise is a TMDB collection: another canonical identity, so it reuses Title wholesale.
    const mediaType = MEDIA_TYPES[dto.type];
    const result = await this.catalog.fetchTitle(dto.tmdbId as number, mediaType);
    // An id the catalogue does not know is a client mistake; writing it would create an entry
    // nothing can ever resolve.
    if (!result) throw new BadRequestException('Unknown title');

    const existing = await this.prisma.title.upsert({
      where: { tmdbId_mediaType: { tmdbId: result.tmdbId, mediaType } },
      create: {
        tmdbId: result.tmdbId,
        mediaType,
        name: result.name,
        year: result.year,
        posterPath: result.posterPath,
        overview: result.overview,
      },
      update: {
        // Refreshed on each binding: posters and overviews change upstream. The overview used to
        // be named in this comment and absent from the object, so a title first bound before its
        // description existed upstream kept a null one for ever.
        name: result.name,
        year: result.year,
        posterPath: result.posterPath,
        overview: result.overview,
        // Back into the enrichment queue. Themes are per creator and seeded from whoever holds
        // the title *at enrichment time*, so a title enriched for creator A and later suggested
        // on creator B's board would otherwise leave B without theme chips forever.
        enrichedAt: null,
      },
      select: { id: true, name: true },
    });

    return { id: existing.id, name: existing.name };
  }

  /**
   * Numbers the steps 0..n-1 from the order they arrived in. A client-supplied position is not
   * trusted: a duplicated or sparse one renders an order nobody can read, and the unique index
   * would reject it anyway.
   */
  async resolveItems(dto: SubmitRecommendationDto) {
    if (dto.type !== 'WATCH_ORDER' || !dto.items) return [];

    const resolved: Array<{
      position: number;
      titleId?: string;
      customTitle?: string;
      note: string | null;
    }> = [];

    // Sequential, not Promise.all: fifty steps meant fifty simultaneous TMDB requests and fifty
    // concurrent upserts, which trips the upstream rate limit and exhausts the connection pool —
    // and a 429 surfaced to the patron as "Unknown title", blaming them for our fan-out.
    for (const [position, item] of dto.items.entries()) {
      const bound = item.tmdbId !== undefined;
      const titled = (item.customTitle ?? '').trim().length > 0;
      // Exactly one identity: neither leaves nothing to render, both is ambiguous about which
      // name is authoritative. The database check constraint enforces the same rule.
      if (bound === titled) {
        throw new BadRequestException('Each step needs either a catalogue id or a title');
      }
      if (!bound) {
        resolved.push({
          position,
          customTitle: (item.customTitle as string).trim(),
          note: item.note?.trim() || null,
        });
        continue;
      }
      // Required alongside tmdbId: TMDB ids are unique only within a media type, so defaulting
      // it silently bound film 1399 for a caller who meant series 1399.
      if (!item.mediaType) {
        throw new BadRequestException('A catalogue step must say whether it is a film or a show');
      }

      const mediaType: MediaType = item.mediaType === 'SHOW' ? 'TV' : 'MOVIE';
      const result = await this.catalog.fetchTitle(item.tmdbId as number, mediaType);
      if (!result) throw new BadRequestException('Unknown title in the watch order');
      const title = await this.prisma.title.upsert({
        where: { tmdbId_mediaType: { tmdbId: result.tmdbId, mediaType } },
        create: {
          tmdbId: result.tmdbId,
          mediaType,
          name: result.name,
          year: result.year,
          posterPath: result.posterPath,
          overview: result.overview,
        },
        update: {
          name: result.name,
          year: result.year,
          posterPath: result.posterPath,
          // Same reason as above: a step's title may be new to this creator's board.
          enrichedAt: null,
        },
        select: { id: true },
      });
      resolved.push({ position, titleId: title.id, note: item.note?.trim() || null });
    }
    return resolved;
  }
}
