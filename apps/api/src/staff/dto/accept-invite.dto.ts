import { IsString, Length } from 'class-validator';

export class AcceptInviteDto {
  // Bounded before it becomes a hash input; an unbounded body is an unbounded hash.
  @IsString()
  @Length(16, 128)
  token!: string;
}
