import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class RaiseTicketDto {
  @IsString()
  @Length(10, 2000)
  body!: string;

  /** The entry this is about. Absent means general contact rather than a dispute. */
  @IsOptional()
  @IsUUID()
  subjectId?: string;
}
