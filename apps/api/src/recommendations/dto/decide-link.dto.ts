import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class DecideLinkDto {
  @IsOptional()
  @IsIn(['CANDIDATE', 'PUBLISHED'])
  status?: 'CANDIDATE' | 'PUBLISHED';

  /** Marking one preferred publishes it: a hidden favourite is no favourite. */
  @IsOptional()
  @IsBoolean()
  isPreferred?: boolean;
}
