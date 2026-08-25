import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class ResolveTicketDto {
  /**
   * Always required, even when the reply deliberately says nothing: "handled internally" is a
   * legitimate answer to a reader and not one to the audit trail.
   */
  @IsIn(['CONFIRMED', 'DENIED', 'LINKED', 'CLOSED'])
  resolution!: 'CONFIRMED' | 'DENIED' | 'LINKED' | 'CLOSED';

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reply?: string;
}
