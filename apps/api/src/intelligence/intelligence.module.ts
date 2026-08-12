import { Global, Module } from '@nestjs/common';
import { RelationsService } from './relations.service';
import { ThemesController } from './themes.controller';
import { ThemesService } from './themes.service';

@Global()
@Module({
  controllers: [ThemesController],
  providers: [RelationsService, ThemesService],
  exports: [RelationsService, ThemesService],
})
export class IntelligenceModule {}
