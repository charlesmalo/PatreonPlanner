import { IsOptional, IsUUID } from 'class-validator';

export class ListNotificationsQuery {
  /** The id of the last row on the previous page. */
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}
