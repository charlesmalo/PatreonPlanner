import { IsUUID } from 'class-validator';

export class GroupEntryDto {
  /** The entry that becomes the head. The one in the path becomes its member. */
  @IsUUID()
  intoId!: string;
}
