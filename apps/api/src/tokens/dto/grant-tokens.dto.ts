import { IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class GrantTokensDto {
  @IsUUID()
  userId!: string;

  /**
   * At least one — granting zero is a ledger row describing nothing. Capped per grant because
   * these are promises the creator has to keep, and a slip of the keyboard should not commit
   * them to fifty of them.
   */
  @IsInt()
  @Min(1)
  @Max(50)
  amount!: number;

  /** Why, in the creator's own words, so the ledger explains itself a year later. */
  @IsString()
  @Length(1, 200)
  reason!: string;
}
