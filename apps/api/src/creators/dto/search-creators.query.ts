import { IsOptional, IsString, Length } from 'class-validator';

export class SearchCreatorsQuery {
  @IsOptional()
  @IsString()
  @Length(0, 100)
  q?: string;
}
