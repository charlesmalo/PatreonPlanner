import { Module } from '@nestjs/common';
import { BlocklistController } from './blocklist.controller';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';
import { CreatorsController } from './creators.controller';
import { CreatorsService } from './creators.service';

@Module({
  // DiscoveryController before CreatorsController: its `GET /creators` must not be shadowed by
  // the parameterised routes.
  controllers: [DiscoveryController, CreatorsController, BlocklistController],
  providers: [CreatorsService, DiscoveryService],
})
export class CreatorsModule {}
