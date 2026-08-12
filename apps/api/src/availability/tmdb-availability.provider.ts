import { Injectable, Logger } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { AvailabilityNotConfiguredError, AvailabilityProvider } from './availability.provider';
import { AvailabilityOffer, AvailabilitySnapshot, OfferKindValue } from './availability.types';

interface TmdbProviderEntry {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
}

interface TmdbRegionEntry {
  link?: string | null;
  flatrate?: TmdbProviderEntry[];
  free?: TmdbProviderEntry[];
  ads?: TmdbProviderEntry[];
  rent?: TmdbProviderEntry[];
  buy?: TmdbProviderEntry[];
}

// Cheapest way to watch first: a patron who already subscribes should not have to read past a
// rental offer to discover that.
const KINDS: Array<[keyof TmdbRegionEntry, OfferKindValue]> = [
  ['flatrate', 'FLATRATE'],
  ['free', 'FREE'],
  ['ads', 'ADS'],
  ['rent', 'RENT'],
  ['buy', 'BUY'],
];

class TitleNotFound extends Error {}

@Injectable()
export class TmdbAvailabilityProvider implements AvailabilityProvider {
  private readonly logger = new Logger(TmdbAvailabilityProvider.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get('TMDB_API_KEY'));
  }

  async fetch(
    tmdbId: number,
    mediaType: MediaType,
    region: string,
  ): Promise<AvailabilitySnapshot | null> {
    const path = mediaType === 'TV' ? 'tv' : 'movie';
    let body: { results?: Record<string, TmdbRegionEntry> };
    try {
      body = await this.get(`/${path}/${tmdbId}/watch/providers`);
    } catch (error) {
      // Only a 404 means "no such title". Anything else is trouble, and swallowing it here would
      // let an outage be cached as "available nowhere".
      if (error instanceof TitleNotFound) return null;
      throw error;
    }

    const entry = body.results?.[region];
    // A region the upstream has no data for is a real answer, not a miss.
    if (!entry) return { region, link: null, offers: [] };

    const offers: AvailabilityOffer[] = KINDS.flatMap(([key, kind]) =>
      ((entry[key] as TmdbProviderEntry[] | undefined) ?? []).map((item) => ({
        providerId: item.provider_id,
        providerName: item.provider_name,
        logoPath: item.logo_path ?? null,
        kind,
        displayPriority: item.display_priority ?? 0,
      })),
    );

    return { region, link: entry.link ?? null, offers };
  }

  private async get<T>(path: string): Promise<T> {
    const key = this.config.get('TMDB_API_KEY');
    if (!key) throw new AvailabilityNotConfiguredError();

    const response = await fetch(`${this.config.get('TMDB_API_BASE_URL')}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 404) throw new TitleNotFound();
      // Status only: the body can echo the query and, on some errors, the key.
      this.logger.warn(`TMDB availability request failed with status ${response.status}`);
      throw new Error('Availability request failed');
    }
    return (await response.json()) as T;
  }
}
