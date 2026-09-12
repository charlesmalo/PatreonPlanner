import { ConflictException } from '@nestjs/common';
import { ModerationActionsService } from '../src/moderation/moderation-actions.service';

/**
 * Which of the two 409s this endpoint answers with.
 *
 * `POST /recommendations/:id/status` refuses for two reasons that need **opposite** remedies: an
 * illegal transition means pick a different move, and a lost race means somebody else already
 * moved it — where the move you asked for may be perfectly legal from where the entry is now.
 * The client branched on the status alone and called both "that move is not allowed from here",
 * which is false for the second and sends a moderator looking for the wrong problem.
 *
 * **Tested here rather than over HTTP, because over HTTP it cannot be deterministic.** The guard
 * fires only when two requests genuinely overlap: if they serialize, the second re-reads the new
 * status and either transitions legally (200) or fails the map (a 409 with no reason). The
 * existing concurrency test in `lifecycle.int-spec.ts` asserts `[200, 409]` precisely because
 * both interleavings are possible. Driving the guard directly is the only way to assert which
 * 409 comes back.
 */
describe('ModerationActionsService conflict reasons', () => {
  const entry = {
    id: 'rec-1',
    status: 'PENDING',
    submittedByUserId: 'u1',
    customTitle: 'Spirited Away',
    creator: { slug: 'ada-writes', displayName: 'Ada Writes' },
    title: null,
  };

  /** Enough Prisma for the read, the transaction, and nothing else: it throws before the rest. */
  const prismaWith = (updateManyCount: number) =>
    ({
      recommendation: { findFirst: jest.fn().mockResolvedValue(entry) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback({
          recommendation: { updateMany: jest.fn().mockResolvedValue({ count: updateManyCount }) },
        }),
      ),
    }) as never;

  const serviceWith = (updateManyCount: number) =>
    new ModerationActionsService(prismaWith(updateManyCount), {} as never, {} as never);

  it('marks a move lost to a concurrent moderator as STALE', async () => {
    const service = serviceWith(0);

    const error = await service
      .changeStatus('creator-1', 'rec-1', 'actor-1', 'ACCEPTED')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ reason: 'STALE' });
  });

  it('leaves an illegal transition unmarked, so a bare 409 still means “not allowed”', async () => {
    // COMPLETED is not reachable from PENDING. This one is refused before the transaction, and
    // carries no reason on purpose: "that move is not allowed from here" is the right thing to
    // say, and is what a bare 409 already meant before this field existed.
    const service = serviceWith(1);

    const error = await service
      .changeStatus('creator-1', 'rec-1', 'actor-1', 'COMPLETED')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).not.toMatchObject({ reason: 'STALE' });
  });
});
