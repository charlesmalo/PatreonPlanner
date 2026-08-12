import { IsOptional, Matches } from 'class-validator';

export class AvailabilityQuery {
  /**
   * ISO-3166-1 alpha-2, uppercase. Rejected rather than coerced: a lowercase code would miss
   * every row the refresh job writes, and an availability answer for the wrong region is worse
   * than none.
   */
  @IsOptional()
  @Matches(/^[A-Z]{2}$/, { message: 'region must be a two-letter ISO-3166-1 country code' })
  region?: string;
}
