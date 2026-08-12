import { Injectable, Logger } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { CatalogNotConfiguredError, CatalogProvider } from './catalog.provider';
import { CatalogResult } from './catalog.types';

const PATHS: Record<MediaType, string> = { MOVIE: 'movie', TV: 'tv', COLLECTION: 'collection' };

interface TmdbItem {
  id: number;
  media_type?: string;
  // TMDB names films with `title` and series with `name`; picking one yields undefined for
  // half the catalogue.
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  overview?: string | null;
}

@Injectable()
export class TmdbCatalogProvider implements CatalogProvider {
  private readonly logger = new Logger(TmdbCatalogProvider.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get('TMDB_API_KEY'));
  }

  /**
   * Two upstream calls: `search/multi` does not return collections, so franchises need their own.
   * One failing degrades the autocomplete rather than emptying it — but both failing throws,
   * because "nothing found" and "we could not ask" are different answers and the second must not
   * render as an empty list.
   */
  async search(query: string): Promise<CatalogResult[]> {
    const encoded = encodeURIComponent(query);
    const [multi, collections] = await Promise.allSettled([
      this.get<{ results?: TmdbItem[] }>(`/search/multi?query=${encoded}&include_adult=false`),
      this.get<{ results?: TmdbItem[] }>(`/search/collection?query=${encoded}`),
    ]);
    if (multi.status === 'rejected' && collections.status === 'rejected') throw multi.reason;

    const works =
      multi.status === 'fulfilled'
        ? (multi.value.results ?? [])
            // `person` results share the shape but are not works; keeping them would offer a
            // director as something to watch.
            .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
            .map((item) => this.toResult(item, item.media_type === 'tv' ? 'TV' : 'MOVIE'))
        : [];
    const groups =
      collections.status === 'fulfilled'
        ? (collections.value.results ?? []).map((item) => this.toResult(item, 'COLLECTION'))
        : [];

    return [...works, ...groups];
  }

  async fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null> {
    const path = PATHS[mediaType];
    try {
      const item = await this.get<TmdbItem>(`/${path}/${tmdbId}`);
      return this.toResult(item, mediaType);
    } catch {
      // An id TMDB does not know is a client mistake, not an outage.
      return null;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const key = this.config.get('TMDB_API_KEY');
    if (!key) throw new CatalogNotConfiguredError();

    const response = await fetch(`${this.config.get('TMDB_API_BASE_URL')}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      // Status only: the body can echo the query and, on some errors, the key.
      this.logger.warn(`TMDB request failed with status ${response.status}`);
      throw new Error('Catalogue request failed');
    }
    return (await response.json()) as T;
  }

  private toResult(item: TmdbItem, mediaType: MediaType): CatalogResult {
    // A collection spans years; picking one from its parts would be a guess, so it has none.
    const date =
      mediaType === 'COLLECTION'
        ? undefined
        : mediaType === 'TV'
          ? item.first_air_date
          : item.release_date;
    const year = Number.parseInt((date ?? '').slice(0, 4), 10);
    return {
      tmdbId: item.id,
      mediaType,
      name: item.title ?? item.name ?? 'Untitled',
      year: Number.isNaN(year) ? null : year,
      posterPath: item.poster_path ?? null,
      overview: item.overview ?? null,
    };
  }
}
