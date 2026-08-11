import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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

const MAINSTREAM = ['MOVIE', 'SHOW'] as const;
export type SubmittableType = 'MOVIE' | 'SHOW' | 'EXTERNAL_LINK';

export class SubmitRecommendationDto {
  // FRANCHISE and WATCH_ORDER need TMDB collections and ordered items, which arrive with the
  // next catalogue plan; accepting them now would create rows nothing can resolve.
  @IsIn(['MOVIE', 'SHOW', 'EXTERNAL_LINK'])
  type!: SubmittableType;

  /**
   * Required for a mainstream type and forbidden otherwise. Cross-field rather than optional,
   * so a MOVIE with no tmdbId is a 400 rather than an unresolvable row, and an EXTERNAL_LINK
   * cannot smuggle a binding past the catalogue check.
   */
  // Two @ValidateIf decorators on one property cancel out — class-validator skips the property
  // when any condition is false — so "must be absent on an external link" is enforced in the
  // service instead, where it can be expressed directly.
  @ValidateIf((dto: SubmitRecommendationDto) => MAINSTREAM.includes(dto.type as 'MOVIE' | 'SHOW'))
  @IsInt()
  @IsPositive()
  tmdbId?: number;

  @ValidateIf((dto: SubmitRecommendationDto) => !MAINSTREAM.includes(dto.type as 'MOVIE' | 'SHOW'))
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
}
