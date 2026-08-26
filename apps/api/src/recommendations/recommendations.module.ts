import { Module } from '@nestjs/common';
import { RecommendationsController } from './recommendations.controller';
import { MyVotesController } from './my-votes.controller';
import { MyVotesService } from './my-votes.service';
import { GroupingService } from './grouping.service';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';
import { RecommendationsService } from './recommendations.service';
import { SearchService } from './search.service';

@Module({
  controllers: [RecommendationsController, MyVotesController, LinksController],
  providers: [RecommendationsService, SearchService, MyVotesService, GroupingService, LinksService],
})
export class RecommendationsModule {}
