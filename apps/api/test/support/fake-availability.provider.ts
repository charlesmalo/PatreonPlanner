import type { MediaType } from '@prisma/client';
import type { AvailabilityProvider } from '../../src/availability/availability.provider';
import type { AvailabilitySnapshot } from '../../src/availability/availability.types';

/** Stands in for TMDB's watch-provider endpoint so no suite reaches the network. */
export class FakeAvailabilityProvider implements AvailabilityProvider {
  calls = 0;
  configured = true;
  throwNext = false;
  providerName = 'Netflix';
  /** Set to null to stand for "the upstream does not know this title". */
  snapshot: AvailabilitySnapshot | null | undefined;

  reset(): void {
    this.calls = 0;
    this.configured = true;
    this.throwNext = false;
    this.providerName = 'Netflix';
    this.snapshot = undefined;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async fetch(
    _tmdbId: number,
    _mediaType: MediaType,
    region: string,
  ): Promise<AvailabilitySnapshot | null> {
    this.calls += 1;
    if (this.throwNext) throw new Error('upstream down');
    if (this.snapshot !== undefined) return this.snapshot;
    return {
      region,
      link: `https://example.invalid/watch/${region}`,
      offers: [
        {
          providerId: 8,
          providerName: this.providerName,
          logoPath: '/netflix.jpg',
          kind: 'FLATRATE',
          displayPriority: 1,
        },
      ],
    };
  }
}
