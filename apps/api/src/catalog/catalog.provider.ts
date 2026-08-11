import { MediaType } from '@prisma/client';
import { CatalogResult } from './catalog.types';

export const CATALOG_PROVIDER = Symbol('CATALOG_PROVIDER');

/** Design §5 puts the catalogue behind an interface so it can be swapped or faked. */
export interface CatalogProvider {
  /** False when no API key is configured; callers degrade rather than crash. */
  isConfigured(): boolean;
  search(query: string): Promise<CatalogResult[]>;
  fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null>;
}

export class CatalogNotConfiguredError extends Error {
  constructor() {
    super('Catalogue search is not configured');
  }
}
