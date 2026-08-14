import { NoteKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsString, Length, ValidateIf } from 'class-validator';

/** Trimmed before the length check, so "   " is an empty body rather than a three-character one. */
const trimmed = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

/**
 * `null` means "clear it" and must reach the service; `@IsOptional()` alone would skip
 * validation for null *and* let it through as a date, and `new Date(null)` is the Unix epoch —
 * which is how a cleared date became "1/1/1970" on a public board.
 */
const optionalDate = () => ValidateIf((_object, value) => value !== null && value !== undefined);

export class WriteNoteDto {
  @IsEnum(NoteKind)
  kind!: NoteKind;

  @trimmed
  @IsString()
  @Length(1, 2000)
  body!: string;

  /**
   * Only meaningful on a TIMELINE note. The service rejects it on a NOTE — two `@ValidateIf`
   * decorators on one property cancel out, so the cross-field rule cannot live here.
   */
  @optionalDate()
  @IsDateString()
  plannedFor?: string | null;
}

export class EditNoteDto {
  @trimmed
  @IsString()
  @Length(1, 2000)
  body!: string;

  /** `null` clears the date; omitting it leaves the existing one alone. */
  @optionalDate()
  @IsDateString()
  plannedFor?: string | null;
}
