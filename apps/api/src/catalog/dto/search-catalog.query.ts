import { IsString, Length } from 'class-validator';

export class SearchCatalogQuery {
  // Bounded before it becomes a cache key; a single character is not a search, it is a scan.
  @IsString()
  @Length(2, 100)
  q!: string;
}
