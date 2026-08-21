import { IsInt, Max, Min } from 'class-validator';

export class SetTierWeightDto {
  /**
   * Zero is allowed — a creator may decide a tier does not carry voting power — but negative is
   * not: a vote that subtracts support is not a thing this board has a meaning for. Capped so a
   * single tier cannot swamp every other signal by accident.
   */
  @IsInt()
  @Min(0)
  @Max(1000)
  voteWeight!: number;
}
