import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ReviewQueueListQuery {
  /**
   * Offset, not a keyset cursor. The queue's leading sort key is a live count of open flags, so
   * a keyset boundary would be invalidated by the very act of moderating — and a queue is walked
   * from the top and re-read, not paged deeply like a board.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
