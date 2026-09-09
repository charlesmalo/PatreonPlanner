import { Body, Controller, Get, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Capability, Policy, Viewer, can } from '../access/capability';
import { ALL_STAFF_PERMISSIONS, type StaffPermissionValue } from '../access/permissions';
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
import { RequirePermission } from '../access/require-permission.decorator';
import { UpdatePolicyDto } from './dto/update-policy.dto';

@Controller('creators')
export class CreatorsController {
  constructor(private readonly creators: CreatorsService) {}

  // Declared before the parameterised routes below so `claimable` is matched as a literal rather
  // than being swallowed by `:slug` — the same reason `claim` sits up here.
  @Get('claimable')
  @UseGuards(SessionGuard)
  claimable(@CurrentUser() user: CurrentUserPayload) {
    return this.creators.listClaimable(user.id);
  }

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
  ): Promise<
    Record<Lowercase<Capability>, boolean> & {
      contact: boolean;
      permissions: StaffPermissionValue[];
    }
  > {
    const policy: Policy = await this.creators.policyForResolver(creator.id);
    return {
      view: can('VIEW', viewer, policy),
      upvote: can('UPVOTE', viewer, policy),
      submit: can('SUBMIT', viewer, policy),
      moderate: can('MODERATE', viewer, policy),
      administer: can('ADMINISTER', viewer, policy),
      // Not a Capability, because it is not resolved from tiers or staff roles — it is the one
      // question `can()` cannot answer. Present because the board had no way to ask it and so
      // drew the contact form behind `view`, offering an anonymous reader of a public board a
      // form the server then refused after they had written the message.
      //
      // Signing in is what makes somebody accountable for what they send, which is the whole
      // reason `allowAnonymousTickets` exists: the flag is about anonymity, not about tickets.
      contact: viewer.isAuthenticated || creator.allowAnonymousTickets,
      // The five booleans above are too coarse to render staff controls: MODERATE is true for
      // any staff member, while the endpoints behind those controls each demand a specific
      // permission. Without this the SPA offers a HANDLE_REPORTS moderator buttons the API
      // then refuses.
      //
      // An OWNER is expanded rather than returned raw. Their powers come from the role
      // short-circuiting `hasPermission`, so their stored column is empty by design, and
      // sending it would hide every control from the one person entitled to all of them —
      // the same short-circuit, expressed once more here because the SPA cannot call it.
      permissions: viewer.staffRole === 'OWNER' ? [...ALL_STAFF_PERMISSIONS] : viewer.permissions,
    };
  }

  // MANAGE_POLICY rather than ADMINISTER, so a creator can delegate the board's settings without
  // handing over the board. An owner holds it by the short-circuit in `hasPermission`, so nothing
  // changes for them; a moderator has it only if it was granted, and no existing staff row was.
  @Get(':creatorId/policy')
  @RequireCapability('MODERATE')
  @RequirePermission('MANAGE_POLICY')
  @UseGuards(CreatorAccessGuard, SessionGuard)
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

  // Not MODERATE: running the queue and deciding who may read the board are different powers,
  // and a moderator arriving by invite link holds only the first unless the creator says
  // otherwise. That was the reason this sat behind ADMINISTER; a permission of its own keeps the
  // reason and makes the delegation possible.
  @Patch(':creatorId/policy')
  @RequireCapability('MODERATE')
  @RequirePermission('MANAGE_POLICY')
  @UseGuards(CreatorAccessGuard, SessionGuard)
  updatePolicy(@CurrentCreator() creator: ResolvedCreator, @Body() dto: UpdatePolicyDto) {
    return this.creators.updatePolicy(creator.id, dto);
  }
}
