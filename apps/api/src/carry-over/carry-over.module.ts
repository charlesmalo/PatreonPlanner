import { Module } from '@nestjs/common';
import { CreatorsModule } from '../creators/creators.module';
import { RecommendationsModule } from '../recommendations/recommendations.module';
import { CarryOverService } from './carry-over.service';

@Module({
  imports: [RecommendationsModule, CreatorsModule],
  providers: [CarryOverService],
  exports: [CarryOverService],
})
export class CarryOverModule {}
