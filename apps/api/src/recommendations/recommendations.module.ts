import { Module } from '@nestjs/common';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';
import { SearchService } from './search.service';

@Module({
  controllers: [RecommendationsController],
  providers: [RecommendationsService, SearchService],
})
export class RecommendationsModule {}
