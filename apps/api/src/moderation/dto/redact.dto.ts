import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RedactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  customTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
