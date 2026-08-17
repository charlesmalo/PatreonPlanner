import { Module } from '@nestjs/common';
import { BlocklistController } from './blocklist.controller';
import { CreatorsController } from './creators.controller';
import { CreatorsService } from './creators.service';

@Module({
  controllers: [CreatorsController, BlocklistController],
  providers: [CreatorsService],
})
export class CreatorsModule {}
