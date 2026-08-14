import { NoteKind } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, Length } from 'class-validator';

export class WriteNoteDto {
  @IsEnum(NoteKind)
  kind!: NoteKind;

  @IsString()
  @Length(1, 2000)
  body!: string;

  /**
   * Only meaningful on a TIMELINE note. The service rejects it on a NOTE — two `@ValidateIf`
   * decorators on one property cancel out, so the cross-field rule cannot live here.
   */
  @IsOptional()
  @IsDateString()
  plannedFor?: string;
}

export class EditNoteDto {
  @IsString()
  @Length(1, 2000)
  body!: string;

  @IsOptional()
  @IsDateString()
  plannedFor?: string;
}
