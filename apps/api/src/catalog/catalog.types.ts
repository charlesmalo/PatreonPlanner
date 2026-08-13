import { MediaType } from '@prisma/client';

export interface CatalogResult {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  posterPath: string | null;
  overview: string | null;
}

/** What TMDB knows about a title's place in the catalogue, for the relation and theme builder. */
export interface TitleStructure {
  /** The collection a film belongs to, from `belongs_to_collection`. */
  collection: { tmdbId: number; name: string } | null;
  /** A collection's members, in TMDB's order. Empty for anything but a COLLECTION. */
  parts: Array<{ tmdbId: number; mediaType: 'MOVIE'; ordinal: number }>;
  /** TMDB's similar titles, capped. */
  similar: Array<{ tmdbId: number; mediaType: MediaType }>;
  /** Genre and keyword labels, for theme seeding. De-duplicated case-insensitively. */
  labels: string[];
}
