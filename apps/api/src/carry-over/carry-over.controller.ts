import { Body, Controller, Get, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { CarryOverDto } from './dto/carry-over.dto';
import { CarryOverService } from './carry-over.service';

/**
 * Not creator-scoped, because the whole point is that it spans boards. The per-board decisions —
 * may this reader submit here, does this creator accept carried-over lists — are made when each
 * delivery runs, not here, so this endpoint cannot be used to probe which boards exist.
 */
@Controller('carry-over')
@UseGuards(SessionGuard)
export class CarryOverController {
  constructor(private readonly carryOver: CarryOverService) {}

  @Post()
  async enqueue(@CurrentUser() user: CurrentUserPayload, @Body() dto: CarryOverDto) {
    if (!(await this.carryOver.mayCarryOver(user.id))) {
      throw new HttpException(
        'Carrying a list across boards is a premium feature',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return { queued: await this.carryOver.enqueueBySlug(user.id, dto.sourceIds, dto.creatorSlugs) };
  }

  @Get('options')
  options(@CurrentUser() user: CurrentUserPayload) {
    return this.carryOver.optionsFor(user.id);
  }

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.carryOver.listFor(user.id);
  }
}
