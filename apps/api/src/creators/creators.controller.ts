import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { CreatorsService } from './creators.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';

@Controller('creators')
export class CreatorsController {
  constructor(private readonly creators: CreatorsService) {}

  @Post('claim')
  @UseGuards(SessionGuard)
  claim(@CurrentUser() user: CurrentUserPayload, @Body() dto: ClaimCreatorDto) {
    return this.creators.claim(user.id, dto);
  }
}
