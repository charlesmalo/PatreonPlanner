import { Transform, Type } from 'class-transformer';
import type { RecommendationStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

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
   * Labels to narrow by, comma-separated, matched as **OR**: an entry carrying any one of them is
   * in. Narrows the same read model rather than adding a second one the rules could drift between.
   *
   * Comma-separated rather than a repeated parameter, so the value is one string whatever its
   * length — Express hands back a string for `?themes=a` and an array for `?themes=a&themes=b`,
   * and a DTO that has to accept both shapes is a DTO with two code paths to keep in step.
   *
   * Capped because each id is validated against the board before the query runs; an unbounded
   * list is an unbounded number of ids to check.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter((part) => part.length > 0) : value,
  )
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  themes?: string[];

  /**
   * One kanban column. Narrows what visibility already allows and can never widen it — a patron
   * asking for REJECTED gets an empty column, not the column.
   */
  @IsOptional()
  @IsIn(['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'REJECTED', 'DELETED'])
  status?: RecommendationStatus;

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
