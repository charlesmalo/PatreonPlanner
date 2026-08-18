import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';

export class ListNotificationsQuery {
  /** The id of the last row on the previous page. */
  @IsOptional()
  @IsUUID('4')
  cursor?: string;

  @IsOptional()
  @IsIn(['ENTRY_STATUS_CHANGED', 'ENTRY_FLAGGED'])
  type?: 'ENTRY_STATUS_CHANGED' | 'ENTRY_FLAGGED';

  // A query string carries text, so the flag arrives as "true" rather than a boolean.
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @IsIn(['newest', 'oldest', 'severity'])
  sort?: 'newest' | 'oldest' | 'severity';
}
