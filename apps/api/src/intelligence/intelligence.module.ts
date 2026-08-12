import { Global, Module } from '@nestjs/common';
import { RelationsService } from './relations.service';
import { ThemesService } from './themes.service';

@Global()
@Module({
  providers: [RelationsService, ThemesService],
  exports: [RelationsService, ThemesService],
})
export class IntelligenceModule {}
