import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { MarkReadDto } from './dto/mark-read.dto';
import { NotificationsService } from './notifications.service';

/**
 * Scoped to the session user throughout — there is no path parameter to get wrong, and no id from
 * the request is ever trusted on its own.
 */
@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload, @Query() query: ListNotificationsQuery) {
    return this.notifications.list(user.id, query.cursor, undefined, {
      type: query.type,
      unreadOnly: query.unreadOnly,
      sort: query.sort,
    });
  }

  // Its own endpoint because the badge polls it: the full list is a much larger answer to a
  // question that is only ever "is there anything new".
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: CurrentUserPayload) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  async markRead(@CurrentUser() user: CurrentUserPayload, @Body() dto: MarkReadDto) {
    return { updated: await this.notifications.markRead(user.id, dto.ids) };
  }
}
