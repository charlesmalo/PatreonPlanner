import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class AddBlockwordDto {
  /** Matched as a substring, so a short word catches a lot: "ass" also catches "assassin". */
  @IsString()
  @Length(2, 100)
  pattern!: string;

  @IsOptional()
  @IsIn(['BLOCK', 'FLAG'])
  action?: 'BLOCK' | 'FLAG';
}
