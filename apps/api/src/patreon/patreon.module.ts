import { Global, Module } from '@nestjs/common';
import { HttpPatreonClient } from './http-patreon.client';
import { PATREON_CLIENT } from './patreon.client';

@Global()
@Module({
  providers: [{ provide: PATREON_CLIENT, useClass: HttpPatreonClient }],
  exports: [PATREON_CLIENT],
})
export class PatreonModule {}
