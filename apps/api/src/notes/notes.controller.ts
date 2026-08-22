import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreatorAccessGuard,
  CurrentCreator,
  ResolvedCreator,
} from '../access/creator-access.guard';
import { RequireCapability } from '../access/require-capability.decorator';
import { RequirePermission } from '../access/require-permission.decorator';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { EditNoteDto, WriteNoteDto } from './dto/write-note.dto';
import { NotesService } from './notes.service';

// Staff only, declared once on the class: a note is the creator's voice on their own board.
@Controller('creators/:slug')
@RequireCapability('MODERATE')
@RequirePermission('WRITE_NOTES')
@UseGuards(CreatorAccessGuard, SessionGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post('recommendations/:id/notes')
  write(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WriteNoteDto,
  ) {
    return this.notes.write(creator.id, id, user.id, dto.kind, dto.body, dto.plannedFor);
  }

  @Patch('notes/:noteId')
  edit(
    @CurrentCreator() creator: ResolvedCreator,
    @CurrentUser() user: CurrentUserPayload,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: EditNoteDto,
  ) {
    return this.notes.edit(creator.id, noteId, user.id, dto.body, dto.plannedFor);
  }

  @Delete('notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentCreator() creator: ResolvedCreator,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ) {
    return this.notes.remove(creator.id, noteId);
  }
}
