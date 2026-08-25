import { Global, Module } from '@nestjs/common';
import { ReactionsController } from './reactions.controller';
import { ReactionsService } from './reactions.service';

// Global: the board decorates its entries with reaction counts, so the recommendations module
// needs this without importing a cycle back into it.
@Global()
@Module({
  controllers: [ReactionsController],
  providers: [ReactionsService],
  exports: [ReactionsService],
})
export class ReactionsModule {}
