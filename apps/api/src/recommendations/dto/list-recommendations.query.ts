import { Type } from 'class-transformer';
import type { RecommendationStatus } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class ListRecommendationsQuery {
  // Opaque, base64url-encoded boundary values — not an id, so it is not a UUID.
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /**
   * The label filter, as `a|b,c` — `(a AND b) OR (c)`. Parsed by `parseLabelFilter`, which owns
   * every rule about its shape; a nested value is one level deeper than `each: true` reaches.
   */
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  themes?: string;

  /**
   * One kanban column. Narrows what visibility already allows and can never widen it — a patron
   * asking for REJECTED gets an empty column, not the column.
   */
  @IsOptional()
  @IsIn(['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'REJECTED', 'DELETED'])
  status?: RecommendationStatus;

  /**
   * Which country's streaming offers to attach, as ISO-3166-1 alpha-2.
   *
   * Validated here only for *shape*. Whether the deployment actually serves a region is
   * `AvailabilityService.assertRegion`'s decision and stays there — the bounded set exists so one
   * caller cannot create a permanent refresh obligation for every country on earth, and that rule
   * belongs with the service that owns the obligation, not copied into a DTO that will drift.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'region must be a two-letter ISO-3166-1 country code' })
  region?: string;

  /** How the column is ordered beneath the creator's own picks, which always lead. */
  @IsOptional()
  @IsIn(['upvotes', 'newest', 'oldest', 'manual'])
  sort?: 'upvotes' | 'newest' | 'oldest' | 'manual';
}

export class SimilarQuery {
  @IsString()
  @Length(1, 200)
  // No control characters. A NUL byte reached Postgres as 22021 and surfaced as an anonymous,
  // repeatable 500 with an error-level log line behind it.
  @Matches(/^[^\p{C}]*$/u, { message: 'q must not contain control characters' })
  q!: string;
}
