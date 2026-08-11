import {
  BadGatewayException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { RedisService } from '../redis/redis.service';
import { CATALOG_PROVIDER, CatalogNotConfiguredError, CatalogProvider } from './catalog.provider';
import { CatalogResult } from './catalog.types';

const CACHE_PREFIX = 'catalog:search:';
// Long, because a film's identity does not change. Design §5 wants repeat lookups never to
// re-hit TMDB.
const CACHE_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class CatalogService {
  constructor(
    @Inject(CATALOG_PROVIDER) private readonly provider: CatalogProvider,
    private readonly redis: RedisService,
  ) {}

  async search(query: string): Promise<CatalogResult[]> {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException('Catalogue search is unavailable');
    }
    // Normalised before it becomes a key, so trivially different spellings share a cache entry
    // and a caller cannot fill Redis with unbounded distinct keys.
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const cacheKey = `${CACHE_PREFIX}${normalized}`;

    const cached = await this.redis.raw().get(cacheKey);
    if (cached) return JSON.parse(cached) as CatalogResult[];

    const results = await this.callProvider(() => this.provider.search(normalized));
    await this.redis.raw().set(cacheKey, JSON.stringify(results), 'EX', CACHE_TTL_SECONDS);
    return results;
  }

  async fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null> {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException('Catalogue is unavailable');
    }
    return this.callProvider(() => this.provider.fetchTitle(tmdbId, mediaType));
  }

  private async callProvider<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof CatalogNotConfiguredError) {
        throw new ServiceUnavailableException('Catalogue is unavailable');
      }
      // Upstream trouble is not the caller's fault and must not read as a bad request.
      throw new BadGatewayException('Could not reach the catalogue');
    }
  }
}
