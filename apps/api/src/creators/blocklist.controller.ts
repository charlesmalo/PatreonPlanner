import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { normalizePattern } from '../moderation/creator-blocklist.moderator';
import { PrismaService } from '../prisma/prisma.service';
import { SessionGuard } from '../session/session.guard';
import { AddBlockwordDto } from './dto/add-blockword.dto';

/**
 * ADMINISTER, not MODERATE. Design §7 files the blocklist under creator admin beside policy: it
 * decides what the board will accept at all, and a moderator who arrived by invite link must not
 * be able to widen or narrow that.
 */
@Controller('creators/:slug/blocklist')
@RequireCapability('ADMINISTER')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class BlocklistController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentCreator() creator: ResolvedCreator) {
    const items = await this.prisma.creatorBlockword.findMany({
      where: { creatorId: creator.id },
      select: { id: true, pattern: true, action: true, createdAt: true },
      orderBy: { pattern: 'asc' },
    });
    return { items };
  }

  @Post()
  async add(@CurrentCreator() creator: ResolvedCreator, @Body() dto: AddBlockwordDto) {
    try {
      return await this.prisma.creatorBlockword.create({
        data: {
          creatorId: creator.id,
          pattern: normalizePattern(dto.pattern),
          action: dto.action ?? 'BLOCK',
        },
        select: { id: true, pattern: true, action: true, createdAt: true },
      });
    } catch (error) {
      // A conflict, not a silent second row: two entries differing only in case would both match
      // and neither would be removable by the one the creator remembers typing.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That word is already on the list');
      }
      throw error;
    }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentCreator() creator: ResolvedCreator, @Param('id', ParseUUIDPipe) id: string) {
    // Scoped by creatorId as well as id: an id alone says nothing about which board owns it.
    const { count } = await this.prisma.creatorBlockword.deleteMany({
      where: { id, creatorId: creator.id },
    });
    if (count === 0) throw new NotFoundException();
  }
}
