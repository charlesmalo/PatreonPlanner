import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class RecommendationLinkDto {
  // http(s) only: a javascript: or data: URL stored now becomes a rendered link later.
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2048)
  url!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  label?: string;
}

// Types that bind a canonical Title and therefore require a tmdbId. WATCH_ORDER is mainstream in
// design §5's sense but has no single upstream identity — it is a curated sequence.
const MAINSTREAM = ['MOVIE', 'SHOW', 'FRANCHISE'] as const;
type MainstreamType = (typeof MAINSTREAM)[number];
const isMainstream = (type: unknown): boolean => MAINSTREAM.includes(type as MainstreamType);

export type SubmittableType = MainstreamType | 'WATCH_ORDER' | 'EXTERNAL_LINK';

/** An ordered step in a WATCH_ORDER. Bound to the catalogue, or free text — never both. */
export class WatchOrderItemDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  tmdbId?: number;

  // Needed alongside tmdbId because TMDB ids are unique only within a media type.
  @IsOptional()
  @IsIn(['MOVIE', 'SHOW'])
  mediaType?: 'MOVIE' | 'SHOW';

  @IsOptional()
  @IsString()
  @Length(1, 200)
  customTitle?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class SubmitRecommendationDto {
  @IsIn(['MOVIE', 'SHOW', 'FRANCHISE', 'WATCH_ORDER', 'EXTERNAL_LINK'])
  type!: SubmittableType;

  /**
   * Required for a mainstream type and forbidden otherwise. Cross-field rather than optional,
   * so a MOVIE with no tmdbId is a 400 rather than an unresolvable row, and an EXTERNAL_LINK
   * cannot smuggle a binding past the catalogue check.
   */
  // Two @ValidateIf decorators on one property cancel out — class-validator skips the property
  // when any condition is false — so "must be absent on an external link" is enforced in the
  // service instead, where it can be expressed directly.
  @ValidateIf((dto: SubmitRecommendationDto) => isMainstream(dto.type))
  @IsInt()
  @IsPositive()
  tmdbId?: number;

  @ValidateIf((dto: SubmitRecommendationDto) => !isMainstream(dto.type))
  @IsString()
  @Length(1, 200)
  customTitle?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => RecommendationLinkDto)
  links?: RecommendationLinkDto[];

  /**
   * Required on a WATCH_ORDER and forbidden elsewhere. Capped because an unbounded list is an
   * unbounded write; the service enforces the "forbidden elsewhere" half, since two @ValidateIf
   * decorators on one property cancel out.
   */
  @ValidateIf((dto: SubmitRecommendationDto) => dto.type === 'WATCH_ORDER')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WatchOrderItemDto)
  items?: WatchOrderItemDto[];
}
