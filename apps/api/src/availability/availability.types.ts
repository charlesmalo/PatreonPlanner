/** How a title is available. Mirrors the arrays TMDB returns per region. */
export type OfferKindValue = 'FLATRATE' | 'FREE' | 'ADS' | 'RENT' | 'BUY';

export interface AvailabilityOffer {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  kind: OfferKindValue;
  displayPriority: number;
}

export interface AvailabilitySnapshot {
  /** ISO-3166-1 alpha-2. An answer without its region answers the wrong question. */
  region: string;
  /** The upstream's own watch page for this title and region; null when it gives none. */
  link: string | null;
  offers: AvailabilityOffer[];
}
