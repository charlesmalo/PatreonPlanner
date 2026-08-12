import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AvailabilityService } from '../availability/availability.service';
import { ConfigService } from '../config/config.module';
import { CreatorAccessGuard } from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CatalogService } from './catalog.service';
import { AvailabilityQuery } from './dto/availability.query';
import { SearchCatalogQuery } from './dto/search-catalog.query';

@Controller('creators/:slug/catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly availability: AvailabilityService,
    private readonly config: ConfigService,
  ) {}

  // SUBMIT, not VIEW: this exists to feed the submit form and it spends a third-party quota, so
  // anyone who cannot submit has no reason to consume it.
  @Get('search')
  @RequireCapability('SUBMIT')
  @UseGuards(CreatorAccessGuard)
  async search(@Query() query: SearchCatalogQuery) {
    return { results: await this.catalog.search(query.q) };
  }

  // VIEW, not SUBMIT: where to watch is information about what is already on the board, so anyone
  // who can read the board can read it. It also costs no third-party quota on the common path —
  // the answer is served from storage.
  @Get('titles/:id/availability')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  async availabilityFor(@Param('id', ParseUUIDPipe) id: string, @Query() query: AvailabilityQuery) {
    const region = query.region ?? this.config.get('AVAILABILITY_REGION_DEFAULT');
    const result = await this.availability.forTitle(id, region);
    // Null covers both "no such title" and "the upstream has nothing" — neither is something the
    // caller can act on differently, and distinguishing them would confirm which ids exist.
    if (!result) throw new NotFoundException();
    return result;
  }
}
