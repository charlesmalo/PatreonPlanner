import { IsString, Length } from 'class-validator';

export class RenameThemeDto {
  @IsString()
  @Length(1, 60)
  name!: string;
}
