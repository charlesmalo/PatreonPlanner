import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { ViewVisibilityValue } from '../../access/capability';

const VISIBILITIES: ViewVisibilityValue[] = ['PUBLIC', 'ANY_PATREON_USER', 'SUBSCRIBERS_ONLY'];

export class UpdatePolicyDto {
  @IsOptional()
  @IsIn(VISIBILITIES)
  viewVisibility?: ViewVisibilityValue;

  // Nullable on purpose: null clears the gate, which is not the same as omitting the field.
  @IsOptional()
  @IsUUID()
  submitMinTierId?: string | null;

  @IsOptional()
  @IsUUID()
  upvoteMinTierId?: string | null;

  @IsOptional()
  @IsBoolean()
  hidePendingFromPublic?: boolean;
}
