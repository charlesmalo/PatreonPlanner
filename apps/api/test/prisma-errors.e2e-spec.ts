import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from '../src/common/prisma-exception.filter';

/** Minimal ArgumentsHost: the filter only reaches for the response. */
function hostFor(captured: { status?: number; body?: unknown }): ArgumentsHost {
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
    },
  };
  return { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
}

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '5.20.0' });

describe('PrismaExceptionFilter', () => {
  const filter = new PrismaExceptionFilter();

  const map = (code: string) => {
    const captured: { status?: number; body?: unknown } = {};
    filter.catch(known(code), hostFor(captured));
    return captured;
  };

  it('answers 404 for a malformed id and a missing row', () => {
    expect(map('P2023').status).toBe(HttpStatus.NOT_FOUND);
    expect(map('P2025').status).toBe(HttpStatus.NOT_FOUND);
  });

  it('answers 409 for a unique violation', () => {
    expect(map('P2002').status).toBe(HttpStatus.CONFLICT);
  });

  it('answers 503 when the pool is exhausted or the database is unreachable', () => {
    // A pool timeout is capacity, not a fault in the request. As a 500 it tells the caller to
    // give up and pages someone; as a 503 it says what is true, and retrying is right for both.
    for (const code of ['P2024', 'P1001', 'P1002', 'P1008', 'P1017']) {
      expect(map(code).status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    }
  });

  it('still answers 500 for anything it does not recognise', () => {
    expect(map('P9999').status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('never puts the Prisma message in the body', () => {
    // Prisma messages carry query fragments and bound values.
    const captured = map('P9999');
    expect(JSON.stringify(captured.body)).not.toContain('x');
  });
});
