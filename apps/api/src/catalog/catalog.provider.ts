import { MediaType } from '@prisma/client';
import { CatalogResult, TitleStructure } from './catalog.types';

export const CATALOG_PROVIDER = Symbol('CATALOG_PROVIDER');

/** Design §5 puts the catalogue behind an interface so it can be swapped or faked. */
export interface CatalogProvider {
  /** False when no API key is configured; callers degrade rather than crash. */
  isConfigured(): boolean;
  search(query: string): Promise<CatalogResult[]>;
  fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null>;
  /**
   * The title's place in the catalogue: collection membership, members, similar titles and
   * labels. Sub-calls degrade individually — relations are garnish, and one failing endpoint
   * must not deny a title its collection — but a failure to read the title itself throws.
   */
  fetchStructure(tmdbId: number, mediaType: MediaType): Promise<TitleStructure>;
}

export class CatalogNotConfiguredError extends Error {
  constructor() {
    super('Catalogue search is not configured');
  }
}
