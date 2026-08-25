import { IsOptional, IsUUID } from 'class-validator';

export class RankEntryDto {
  /**
   * The neighbours the card was dropped between. Both absent means it was dropped into an empty
   * column; either one absent means an edge.
   *
   * Neighbours rather than a number: the client knows where it dropped the card, and the server
   * owns what rank that is — a client sending its own number would race every other client.
   */
  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @IsUUID()
  beforeId?: string;
}
