import type { MediaType } from '@prisma/client';
import type { AvailabilitySnapshot } from './availability.types';

export const AVAILABILITY_PROVIDER = Symbol('AVAILABILITY_PROVIDER');

/**
 * Design §5 puts availability behind an interface so a paid deep-link provider can join or
 * replace the free TMDB baseline without the board knowing.
 */
export interface AvailabilityProvider {
  /** False when no API key is configured; callers degrade to no badges rather than crash. */
  isConfigured(): boolean;
  /**
   * Returns null only when the upstream does not know the title. A region the upstream has no
   * data for yields an *empty* snapshot, which is a real answer and must be cacheable — null
   * would mean "never asked", and the refresh job would ask again forever.
   *
   * Throws on upstream trouble. An outage must never be stored as "available nowhere".
   */
  fetch(
    tmdbId: number,
    mediaType: MediaType,
    region: string,
  ): Promise<AvailabilitySnapshot | null>;
}

export class AvailabilityNotConfiguredError extends Error {
  constructor() {
    super('Availability lookup is not configured');
  }
}
