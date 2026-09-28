import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class SetTierWeightDto {
  /**
   * Zero is allowed — a creator may decide a tier does not carry voting power — but negative is
   * not: a vote that subtracts support is not a thing this board has a meaning for. Capped so a
   * single tier cannot swamp every other signal by accident.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1000)
  voteWeight?: number;

  /**
   * Redeem tokens granted to this tier's members each period.
   *
   * Zero is where every tier starts, so enabling the feature grants nothing until the creator
   * says who gets what. Capped well below the vote weight's ceiling because these are promises
   * the creator has to keep: a hundred redeems a month is a hundred things somebody expects
   * played, and a board that cannot keep up has sold something it cannot deliver.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(50)
  tokensPerPeriod?: number;
}
