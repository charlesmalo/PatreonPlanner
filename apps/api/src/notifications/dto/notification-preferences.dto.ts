import { ArrayUnique, IsArray, IsIn } from 'class-validator';

/**
 * Only the columns a reader can actually look at.
 *
 * `DELETED` and `REJECTED` are off the board by design, so offering them would promise
 * notifications about entries that cannot be opened — a setting that lies about what it does.
 */
export const NOTIFIABLE_STATUSES = ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED'] as const;

export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

export class SetNotificationPreferencesDto {
  /**
   * The whole set, not a change to it: the page edits checkboxes, and a partial update races two
   * open tabs into a merge nobody asked for. An empty array is silence and is deliberately valid.
   */
  @IsArray()
  @ArrayUnique()
  @IsIn(NOTIFIABLE_STATUSES, { each: true })
  statuses!: NotifiableStatus[];
}
