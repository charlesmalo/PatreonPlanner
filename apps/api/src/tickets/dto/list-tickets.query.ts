import { IsIn, IsOptional } from 'class-validator';

export class ListTicketsQuery {
  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED'])
  status?: 'OPEN' | 'RESOLVED';
}
