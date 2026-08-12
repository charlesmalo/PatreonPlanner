import { FlagStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveFlagDto {
  @IsEnum(FlagStatus)
  status!: FlagStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
