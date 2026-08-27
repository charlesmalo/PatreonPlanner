import { Module } from '@nestjs/common';
import { BoardSettingsController } from './board-settings.controller';
import { BoardSettingsService } from './board-settings.service';

@Module({
  controllers: [BoardSettingsController],
  providers: [BoardSettingsService],
})
export class BoardSettingsModule {}
