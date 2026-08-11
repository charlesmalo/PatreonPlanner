import { MediaType } from '@prisma/client';

export interface CatalogResult {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  posterPath: string | null;
  overview: string | null;
}
