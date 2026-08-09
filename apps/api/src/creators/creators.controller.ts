import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { CreatorsService } from './creators.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';
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

  @Get(':creatorId/policy')
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard)
  policy(@CurrentCreator() creator: ResolvedCreator) {
    return this.creators.getPolicy(creator.id);
  }

  @Patch(':creatorId/policy')
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard)
  updatePolicy(@CurrentCreator() creator: ResolvedCreator, @Body() dto: UpdatePolicyDto) {
    return this.creators.updatePolicy(creator.id, dto);
  }
}
