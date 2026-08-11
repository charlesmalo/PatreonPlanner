import { MediaType } from '@prisma/client';
import { CatalogProvider } from '../../src/catalog/catalog.provider';
import { CatalogResult } from '../../src/catalog/catalog.types';

/** Deterministic stand-in, with a call log so caching can be asserted by count. */
export class FakeCatalogProvider implements CatalogProvider {
  public configured = true;
  public results: CatalogResult[] = [];
  public searchCalls: string[] = [];
  public shouldFail = false;

  isConfigured(): boolean {
    return this.configured;
  }

  async search(query: string): Promise<CatalogResult[]> {
    this.searchCalls.push(query);
    if (this.shouldFail) throw new Error('Catalogue request failed');
    return this.results;
  }

  async fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null> {
    if (this.shouldFail) throw new Error('Catalogue request failed');
    return this.results.find((r) => r.tmdbId === tmdbId && r.mediaType === mediaType) ?? null;
  }
}
