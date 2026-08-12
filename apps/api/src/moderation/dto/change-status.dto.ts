import { RecommendationStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ChangeStatusDto {
  @IsEnum(RecommendationStatus)
  status!: RecommendationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
