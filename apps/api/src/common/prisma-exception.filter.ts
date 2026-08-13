import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Turns Prisma's low-level errors into the responses design §9 requires. Without it a malformed
 * UUID in a route parameter, or a row that vanished between check and use, escapes as a 500 with
 * a stack trace — remotely triggerable, and noisy enough to bury real alerts.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, message } = this.translate(exception);

    const code =
      exception instanceof Prisma.PrismaClientKnownRequestError ? exception.code : 'validation';
    // Log the code, never the message: Prisma includes query fragments and bound values. An
    // unmapped code is logged at error, because it is the one case where the caller gets a bare
    // 500 and the code is the only thing that says why — a silent default branch is how an
    // intermittent 500 stays undiagnosable across a dozen runs.
    const logLine = `Prisma error mapped to ${status}: ${code}`;
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) this.logger.error(logLine);
    else this.logger.warn(logLine);
    response.status(status).json({ statusCode: status, message });
  }

  private translate(
    exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError,
  ): { status: number; message: string } {
    if (exception instanceof Prisma.PrismaClientValidationError) {
      // A body that satisfied the DTO but not the schema — e.g. an explicit null on a
      // non-nullable column.
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid request' };
    }
    switch (exception.code) {
      // Malformed value for the column type, e.g. a non-UUID id in the path.
      case 'P2023':
        return { status: HttpStatus.NOT_FOUND, message: 'Not found' };
      // findUniqueOrThrow / update against a row that is not there.
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, message: 'Not found' };
      case 'P2002':
        return { status: HttpStatus.CONFLICT, message: 'Already exists' };
      // Capacity and connectivity, not a fault in the request: the pool was exhausted or the
      // database was unreachable. A 500 tells the caller to give up and pages someone; a 503
      // says what is true, and retrying is the right response to both.
      case 'P2024':
      case 'P1001':
      case 'P1002':
      case 'P1008':
      case 'P1017':
        return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Service unavailable' };
      default:
        return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
    }
  }
}
