import { FlagReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateFlagDto {
  @IsEnum(FlagReason)
  reason!: FlagReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
