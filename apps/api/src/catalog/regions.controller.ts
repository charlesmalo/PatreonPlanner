import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

/**
 * Which regions this deployment can answer "where to watch" for.
 *
 * A route rather than a constant in the client, because the set is deployment configuration
 * (`AVAILABILITY_REGIONS`) and a hardcoded copy drifts the moment an operator edits it — leaving
 * a reader able to pick a country the server will refuse, which reads as a broken setting.
 *
 * Deliberately outside `creators/:slug`: where a reader lives is not a property of whose board
 * they are looking at, and gating it per creator would make the control unavailable before a
 * board had loaded.
 *
 * Unauthenticated, because availability is shown to signed-out readers too and this exposes
 * nothing but a list of country codes an operator chose.
 */
@Controller('meta')
export class RegionsController {
  constructor(private readonly config: ConfigService) {}

  @Get('regions')
  regions() {
    return {
      regions: this.config.get('AVAILABILITY_REGIONS').split(','),
      default: this.config.get('AVAILABILITY_REGION_DEFAULT'),
    };
  }
}
