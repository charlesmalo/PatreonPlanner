import { Body, Controller, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { SessionGuard } from '../session/session.guard';
import { TiersService } from './tiers.service';
import { SetTierWeightDto } from './dto/set-tier-weight.dto';

/**
 * ADMINISTER, not MODERATE: what a tier is worth is board policy, beside the paywall. A moderator
 * curates what shows first; only the owner decides whose vote counts for more.
 */
@Controller('creators/:slug/tiers')
@RequireCapability('ADMINISTER')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class TiersController {
  constructor(private readonly tiers: TiersService) {}

  @Patch(':id')
  setWeight(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTierWeightDto,
  ) {
    return this.tiers.setWeight(creator.id, id, {
      voteWeight: dto.voteWeight,
      tokensPerPeriod: dto.tokensPerPeriod,
    });
  }
}
