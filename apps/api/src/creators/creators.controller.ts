import { Body, Controller, Get, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Capability, Policy, Viewer, can } from '../access/capability';
import {
  CreatorAccessGuard,
  CurrentCreator,
  CurrentViewer,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { CreatorsService } from './creators.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';
import { SetWebhookSecretDto } from './dto/set-webhook-secret.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';

@Controller('creators')
export class CreatorsController {
  constructor(private readonly creators: CreatorsService) {}

  // Declared before the parameterised routes below so `claim` is matched as a literal rather
  // than being swallowed by `:slug`.
  @Post('claim')
  @UseGuards(SessionGuard)
  claim(@CurrentUser() user: CurrentUserPayload, @Body() dto: ClaimCreatorDto) {
    return this.creators.claim(user.id, dto);
  }

  @Get(':slug')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  profile(@CurrentCreator() creator: ResolvedCreator) {
    return this.creators.publicProfile(creator.id);
  }

  /**
   * What this viewer may do here. The SPA needs it to decide which controls to render — design
   * §4 is explicit that the SPA never gates security, so this is a rendering hint computed by
   * the same resolver the guard uses, never a substitute for it.
   */
  @Get(':slug/capabilities')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  async capabilities(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Record<Lowercase<Capability>, boolean>> {
    const policy: Policy = await this.creators.policyForResolver(creator.id);
    return {
      view: can('VIEW', viewer, policy),
      upvote: can('UPVOTE', viewer, policy),
      submit: can('SUBMIT', viewer, policy),
      moderate: can('MODERATE', viewer, policy),
      administer: can('ADMINISTER', viewer, policy),
    };
  }

  @Get(':creatorId/policy')
  @RequireCapability('ADMINISTER')
  @UseGuards(CreatorAccessGuard)
  policy(@CurrentCreator() creator: ResolvedCreator) {
    return this.creators.getPolicy(creator.id);
  }

  // ADMINISTER, not MODERATE: whoever holds this secret can forge membership events, minting
  // active-patron status at any pledge for anyone on the campaign.
  @Put(':creatorId/webhook-secret')
  @RequireCapability('ADMINISTER')
  @UseGuards(CreatorAccessGuard)
  setWebhookSecret(@CurrentCreator() creator: ResolvedCreator, @Body() dto: SetWebhookSecretDto) {
    return this.creators.setWebhookSecret(creator.id, dto.secret);
  }

  // ADMINISTER, not MODERATE: this is the paywall switch. Design §7 files policy under Creator
  // admin alongside staff, and a moderator arriving by invite link must not hold it.
  @Patch(':creatorId/policy')
  @RequireCapability('ADMINISTER')
  @UseGuards(CreatorAccessGuard)
  updatePolicy(@CurrentCreator() creator: ResolvedCreator, @Body() dto: UpdatePolicyDto) {
    return this.creators.updatePolicy(creator.id, dto);
  }
}
