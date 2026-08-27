import { ArrayUnique, IsArray, IsIn, IsObject } from 'class-validator';

/** The columns a reader actually sees. DELETED and REJECTED are off the board. */
export const BOARD_COLUMNS = ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED'] as const;

/** The sorts a column offers. Empty string is the default, which is what the control sends. */
export const BOARD_SORTS = ['', 'newest', 'oldest', 'manual'] as const;

export class SetBoardSettingsDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(BOARD_COLUMNS, { each: true })
  collapsed!: string[];

  /**
   * `{ PENDING: 'manual', … }`. Validated in the service rather than by a decorator: this is a
   * record with a constrained key *and* a constrained value, which class-validator cannot say,
   * and `sorts` is `Json` in the database so nothing downstream would catch a bad one.
   */
  @IsObject()
  sorts!: Record<string, string>;
}
