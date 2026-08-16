import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

export class MarkReadDto {
  /**
   * Absent means every unread row. Bounded because this is a list straight from a request body,
   * and an unbounded `IN` is a cheap way to make one request do a lot of work.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  ids?: string[];
}
