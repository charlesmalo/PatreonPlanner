import { IsUUID } from 'class-validator';

export class MergeThemeDto {
  /** The theme that survives. The one named in the path is the one that goes away. */
  @IsUUID()
  intoId!: string;
}
