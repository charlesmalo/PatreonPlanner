import { Module } from '@nestjs/common';
import { CreatorsModule } from '../creators/creators.module';
import { RecommendationsModule } from '../recommendations/recommendations.module';
import { CarryOverJob } from './carry-over.job';
import { CarryOverService } from './carry-over.service';

@Module({
  imports: [RecommendationsModule, CreatorsModule],
  providers: [CarryOverService, CarryOverJob],
  exports: [CarryOverService, CarryOverJob],
})
export class CarryOverModule {}
