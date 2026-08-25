import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { REACTIONS, type Reaction } from '../palette';

export class ReactDto {
  /** Exactly one of these; the service refuses neither and both. */
  @IsOptional()
  @IsUUID()
  recommendationId?: string;

  @IsOptional()
  @IsUUID()
  noteId?: string;

  // The set is one we ship; anything else is a client sending what it likes.
  @IsIn(REACTIONS as readonly string[])
  emote!: Reaction;
}
