import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, IsUUID } from 'class-validator';

/**
 * Capped on both sides. The product of the two is how much work this puts on other people's
 * boards, and an uncapped request queues tens of thousands of deliveries with one call — which
 * the per-board rate limit would then meter out for weeks.
 */
export class CarryOverDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  sourceIds!: string[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  creatorSlugs!: string[];
}
