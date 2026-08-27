import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { BoardFollowersService } from './board-followers.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsService } from './notifications.service';

// Global: the triggers live in the modules that own the events — moderation raises them, not this
// module — and threading an import into each of those is ceremony around one provider.
@Global()
@Module({
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [NotificationsService, BoardFollowersService, NotificationPreferencesService],
  exports: [NotificationsService, BoardFollowersService],
})
export class NotificationsModule {}
