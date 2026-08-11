import { Injectable, Logger } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { CatalogNotConfiguredError, CatalogProvider } from './catalog.provider';
import { CatalogResult } from './catalog.types';

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

  async search(query: string): Promise<CatalogResult[]> {
    const body = await this.get<{ results?: TmdbItem[] }>(
      `/search/multi?query=${encodeURIComponent(query)}&include_adult=false`,
    );
    return (
      (body.results ?? [])
        // `person` results share the shape but are not works; keeping them would offer a director
        // as something to watch.
        .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
        .map((item) => this.toResult(item, item.media_type === 'tv' ? 'TV' : 'MOVIE'))
    );
  }

  async fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null> {
    const path = mediaType === 'TV' ? 'tv' : 'movie';
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
    const date = mediaType === 'TV' ? item.first_air_date : item.release_date;
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
