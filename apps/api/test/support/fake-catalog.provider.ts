import { MediaType } from '@prisma/client';
import { CatalogProvider } from '../../src/catalog/catalog.provider';
import { TitleStructure } from '../../src/catalog/catalog.types';
import { CatalogResult } from '../../src/catalog/catalog.types';

/** Deterministic stand-in, with a call log so caching can be asserted by count. */
export class FakeCatalogProvider implements CatalogProvider {
  public configured = true;
  public results: CatalogResult[] = [];
  public searchCalls: string[] = [];
  public shouldFail = false;
  public structureCalls = 0;
  /** What fetchStructure answers. Keyed by `tmdbId:mediaType`, with a default for the rest. */
  public structures = new Map<string, TitleStructure>();
  public defaultStructure: TitleStructure = {
    collection: null,
    parts: [],
    similar: [],
    labels: [],
    aliases: [],
  };

  isConfigured(): boolean {
    return this.configured;
  }

  async search(query: string): Promise<CatalogResult[]> {
    this.searchCalls.push(query);
    if (this.shouldFail) throw new Error('Catalogue request failed');
    return this.results;
  }

  async fetchStructure(tmdbId: number, mediaType: MediaType): Promise<TitleStructure> {
    this.structureCalls += 1;
    if (this.shouldFail) throw new Error('Catalogue request failed');
    return this.structures.get(`${tmdbId}:${mediaType}`) ?? this.defaultStructure;
  }

  async fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null> {
    if (this.shouldFail) throw new Error('Catalogue request failed');
    return this.results.find((r) => r.tmdbId === tmdbId && r.mediaType === mediaType) ?? null;
  }
}
