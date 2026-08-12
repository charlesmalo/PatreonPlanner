import { Injectable, Logger } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { CatalogNotConfiguredError, CatalogProvider } from './catalog.provider';
import { CatalogResult, TitleStructure } from './catalog.types';

class TitleNotFound extends Error {}

/** TMDB's similar list is long and weak; a cap keeps the relation table from bloating on noise. */
export const SIMILAR_CAP = 12;

const PATHS: Record<MediaType, string> = { MOVIE: 'movie', TV: 'tv', COLLECTION: 'collection' };

interface TmdbDetail {
  id: number;
  belongs_to_collection?: { id: number; name: string } | null;
  genres?: Array<{ name: string }>;
  parts?: Array<{ id: number }>;
}

interface TmdbKeywords {
  keywords?: Array<{ name: string }>;
  results?: Array<{ name: string }>;
}

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
      this.get<{ results?: TmdbItem[] }>(`/search/collection?query=${encoded}&include_adult=false`),
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
    } catch (error) {
      // Only a 404 means "no such title". Swallowing everything told a patron their perfectly
      // valid watch order contained an "Unknown title" when TMDB had merely rate-limited us.
      if (error instanceof TitleNotFound) return null;
      throw error;
    }
  }

  async fetchStructure(tmdbId: number, mediaType: MediaType): Promise<TitleStructure> {
    const path = PATHS[mediaType];
    // Not degraded: without the title itself there is no structure to speak of, and an empty
    // one would be written as fact.
    const detail = await this.get<TmdbDetail>(`/${path}/${tmdbId}`);

    if (mediaType === 'COLLECTION') {
      return {
        collection: null,
        parts: (detail.parts ?? []).map((part, ordinal) => ({
          tmdbId: part.id,
          mediaType: 'MOVIE' as const,
          ordinal,
        })),
        similar: [],
        labels: dedupeLabels((detail.genres ?? []).map((g) => g.name)),
      };
    }

    // Each degrades on its own: one failing endpoint must not cost the title its collection.
    const [keywords, similar] = await Promise.all([
      this.getOrNull<TmdbKeywords>(`/${path}/${tmdbId}/keywords`),
      this.getOrNull<{ results?: Array<{ id: number }> }>(`/${path}/${tmdbId}/similar`),
    ]);

    // TMDB returns `keywords` for a film and `results` for a series, under the same path.
    const keywordNames = (keywords?.keywords ?? keywords?.results ?? []).map((k) => k.name);

    return {
      collection: detail.belongs_to_collection
        ? { tmdbId: detail.belongs_to_collection.id, name: detail.belongs_to_collection.name }
        : null,
      parts: [],
      similar: (similar?.results ?? [])
        .slice(0, SIMILAR_CAP)
        .map((item) => ({ tmdbId: item.id, mediaType })),
      labels: dedupeLabels([...(detail.genres ?? []).map((g) => g.name), ...keywordNames]),
    };
  }

  /** For the optional parts of a structure, where a failure means "unknown", not "broken". */
  private async getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch {
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
      if (response.status === 404) throw new TitleNotFound();
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

/** Two labels differing only in case are one theme; the first spelling seen wins. */
function dedupeLabels(labels: string[]): string[] {
  const seen = new Map<string, string>();
  for (const label of labels) {
    const key = label.trim().toLowerCase();
    if (key.length > 0 && !seen.has(key)) seen.set(key, label.trim());
  }
  return [...seen.values()];
}
