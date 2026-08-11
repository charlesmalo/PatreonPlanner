import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
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

export class SubmitRecommendationDto {
  // Only EXTERNAL_LINK until Plan 06 brings TMDB: a MOVIE with no Title behind it would be a
  // row nothing can ever resolve.
  @IsIn(['EXTERNAL_LINK'])
  type!: 'EXTERNAL_LINK';

  @IsString()
  @Length(1, 200)
  customTitle!: string;

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
