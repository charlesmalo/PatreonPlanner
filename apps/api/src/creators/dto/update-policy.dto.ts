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
}
