import { Global, Module } from '@nestjs/common';
import { HttpPatreonClient } from './http-patreon.client';
import { PATREON_CLIENT } from './patreon.client';
import { PatreonTokenService } from './patreon-token.service';

@Global()
@Module({
  providers: [{ provide: PATREON_CLIENT, useClass: HttpPatreonClient }, PatreonTokenService],
  exports: [PATREON_CLIENT, PatreonTokenService],
})
export class PatreonModule {}
