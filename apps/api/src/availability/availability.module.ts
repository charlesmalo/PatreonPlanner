import { Global, Module } from '@nestjs/common';
import { AVAILABILITY_PROVIDER } from './availability.provider';
import { AvailabilityService } from './availability.service';
import { TmdbAvailabilityProvider } from './tmdb-availability.provider';

@Global()
@Module({
  providers: [
    { provide: AVAILABILITY_PROVIDER, useClass: TmdbAvailabilityProvider },
    AvailabilityService,
  ],
  exports: [AVAILABILITY_PROVIDER, AvailabilityService],
})
export class AvailabilityModule {}
