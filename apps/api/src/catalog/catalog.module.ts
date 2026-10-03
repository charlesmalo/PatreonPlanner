import { Global, Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { RegionsController } from './regions.controller';
import { CATALOG_PROVIDER } from './catalog.provider';
import { CatalogService } from './catalog.service';
import { TmdbCatalogProvider } from './tmdb-catalog.provider';

@Global()
@Module({
  controllers: [CatalogController, RegionsController],
  providers: [{ provide: CATALOG_PROVIDER, useClass: TmdbCatalogProvider }, CatalogService],
  exports: [CATALOG_PROVIDER, CatalogService],
})
export class CatalogModule {}
