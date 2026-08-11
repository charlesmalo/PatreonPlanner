import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CreatorAccessGuard } from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CatalogService } from './catalog.service';
import { SearchCatalogQuery } from './dto/search-catalog.query';

@Controller('creators/:slug/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // SUBMIT, not VIEW: this exists to feed the submit form and it spends a third-party quota, so
  // anyone who cannot submit has no reason to consume it.
  @Get('search')
  @RequireCapability('SUBMIT')
  @UseGuards(CreatorAccessGuard)
  async search(@Query() query: SearchCatalogQuery) {
    return { results: await this.catalog.search(query.q) };
  }
}
