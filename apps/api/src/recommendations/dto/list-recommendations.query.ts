import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

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

  /** Narrows the same read model rather than adding a second one the rules could drift between. */
  @IsOptional()
  @IsUUID()
  theme?: string;
}

export class SimilarQuery {
  @IsString()
  @Length(1, 200)
  // No control characters. A NUL byte reached Postgres as 22021 and surfaced as an anonymous,
  // repeatable 500 with an error-level log line behind it.
  @Matches(/^[^\p{C}]*$/u, { message: 'q must not contain control characters' })
  q!: string;
}
