import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { BoardFollowersService } from './board-followers.service';
import { NotificationsService } from './notifications.service';

// Global: the triggers live in the modules that own the events — moderation raises them, not this
// module — and threading an import into each of those is ceremony around one provider.
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, BoardFollowersService],
  exports: [NotificationsService, BoardFollowersService],
})
export class NotificationsModule {}
