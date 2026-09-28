import { IsBoolean, IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { ViewVisibilityValue } from '../../access/capability';

const VISIBILITIES: ViewVisibilityValue[] = ['PUBLIC', 'ANY_PATREON_USER', 'SUBSCRIBERS_ONLY'];

/**
 * `@IsOptional()` waves through `null` as well as `undefined`, so it is used only where null is
 * a meaningful value. On the non-nullable columns it would let an explicit null reach Prisma and
 * surface as a 500.
 */
export class UpdatePolicyDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(VISIBILITIES)
  viewVisibility?: ViewVisibilityValue;

  // Nullable on purpose: null clears the gate, which is not the same as omitting the field.
  @IsOptional()
  @IsUUID()
  submitMinTierId?: string | null;

  @IsOptional()
  @IsUUID()
  upvoteMinTierId?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  hidePendingFromPublic?: boolean;

  /*
   * The rest of what a creator already decides, which the API held and never let anybody set.
   * Every one of these was reachable only by editing the database directly.
   */

  /** A public contact form on a public board is the highest-value spam target in the app. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  allowAnonymousTickets?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  allowReactions?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  acceptsCarryOver?: boolean;

  /** Whether a patron may lift votes cast at a cheaper tier to the one they now pay. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  allowVoteRatchet?: boolean;

  /**
   * Whether this board grants redeem tokens at all. Off until the creator says otherwise, and
   * turning it off keeps every balance and redeem — they stop being visible and spendable, and
   * come back unchanged if it is turned on again.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  redeemTokensEnabled?: boolean;
}
