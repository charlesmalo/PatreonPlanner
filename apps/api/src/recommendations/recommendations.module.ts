import { Module } from '@nestjs/common';
import { RecommendationsController } from './recommendations.controller';
import { MyVotesController } from './my-votes.controller';
import { MyVotesService } from './my-votes.service';
import { GroupingService } from './grouping.service';
import { RecommendationsService } from './recommendations.service';
import { SearchService } from './search.service';

@Module({
  controllers: [RecommendationsController, MyVotesController],
  providers: [RecommendationsService, SearchService, MyVotesService, GroupingService],
})
export class RecommendationsModule {}
