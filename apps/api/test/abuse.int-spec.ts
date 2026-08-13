import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AbuseService, DECAY_BATCH_SIZE } from '../src/abuse/abuse.service';
import { DECAY_AFTER_MS, MAX_PENALTY_MS } from '../src/abuse/penalty';
import { startDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';

const HOUR = 60 * 60 * 1000;

describe('AbuseService (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let abuse: AbuseService;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
  }, 240_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  beforeEach(async () => {
    await prisma.abuseRecord.deleteMany();
    await prisma.user.deleteMany();
    abuse = new AbuseService(prisma as never);
    userId = (await prisma.user.create({ data: { patreonUserId: 'ab-user' } })).id;
    otherUserId = (await prisma.user.create({ data: { patreonUserId: 'ab-other' } })).id;
  });

  const strikeTimes = async (id: string, times: number) => {
    for (let i = 0; i < times; i += 1) await abuse.strike(id, 'MODERATION_BLOCK');
  };

  const record = (id: string) => prisma.abuseRecord.findUniqueOrThrow({ where: { userId: id } });

  /** Backdates the last strike so the decay job considers the user quiet. */
  const makeQuiet = (id: string) =>
    prisma.abuseRecord.update({
      where: { userId: id },
      data: { lastStrikeAt: new Date(Date.now() - DECAY_AFTER_MS - 1000), timeoutUntil: null },
    });

  describe('striking', () => {
    it('records a first strike without timing anyone out', async () => {
      await abuse.strike(userId, 'MODERATION_BLOCK');
      expect(await abuse.timeoutFor(userId)).toBeNull();
      expect(await record(userId)).toMatchObject({
        strikeCount: 1,
        lastReason: 'MODERATION_BLOCK',
      });
    });

    it('times a user out on the second strike', async () => {
      await strikeTimes(userId, 2);
      const until = await abuse.timeoutFor(userId);
      expect(until).not.toBeNull();
      expect((until as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('extends rather than shortens an active timeout', async () => {
      // A naive `now + penalty` shortens a long timeout whenever the new penalty is smaller —
      // which is exactly what happens after a decay pass lowers the count.
      await strikeTimes(userId, 6);
      const long = (await abuse.timeoutFor(userId)) as Date;
      await prisma.abuseRecord.update({ where: { userId }, data: { strikeCount: 1 } });

      await abuse.strike(userId, 'RATE_LIMIT');
      const after = (await abuse.timeoutFor(userId)) as Date;
      expect(after.getTime()).toBeGreaterThanOrEqual(long.getTime());
    });

    it('reports no timeout once it has lapsed', async () => {
      await strikeTimes(userId, 2);
      await prisma.abuseRecord.update({
        where: { userId },
        data: { timeoutUntil: new Date(Date.now() - 1000) },
      });
      expect(await abuse.timeoutFor(userId)).toBeNull();
    });

    it('never times out for longer than the cap', async () => {
      await strikeTimes(userId, 40);
      const until = (await abuse.timeoutFor(userId)) as Date;
      expect(until.getTime() - Date.now()).toBeLessThanOrEqual(MAX_PENALTY_MS + 5000);
    });

    it('counts two simultaneous strikes as two', async () => {
      // The count drives the penalty, so a lost update is a discount for hitting harder.
      await Promise.all([abuse.strike(userId, 'RATE_LIMIT'), abuse.strike(userId, 'RATE_LIMIT')]);
      expect((await record(userId)).strikeCount).toBe(2);
    });

    it('keeps users apart', async () => {
      await strikeTimes(userId, 3);
      expect(await abuse.timeoutFor(otherUserId)).toBeNull();
    });

    it('answers null for a user with no record, without creating one', async () => {
      expect(await abuse.timeoutFor(otherUserId)).toBeNull();
      expect(await prisma.abuseRecord.count()).toBe(0);
    });
  });

  describe('decaying', () => {
    it('removes one strike after a quiet period', async () => {
      await strikeTimes(userId, 3);
      await makeQuiet(userId);
      expect(await abuse.decayOnce()).toBe(1);
      expect((await record(userId)).strikeCount).toBe(2);
    });

    it('leaves a recently struck user alone', async () => {
      await strikeTimes(userId, 3);
      await abuse.decayOnce();
      expect((await record(userId)).strikeCount).toBe(3);
    });

    it('deletes the record when the last strike decays', async () => {
      // Otherwise the table accumulates a row per user who ever slipped once.
      await abuse.strike(userId, 'RATE_LIMIT');
      await makeQuiet(userId);
      await abuse.decayOnce();
      expect(await prisma.abuseRecord.count({ where: { userId } })).toBe(0);
    });

    it('does not decay a user whose timeout is still running', async () => {
      // Sitting out a penalty must not also earn forgiveness for it.
      await strikeTimes(userId, 3);
      await makeQuiet(userId);
      await prisma.abuseRecord.update({
        where: { userId },
        data: { timeoutUntil: new Date(Date.now() + HOUR) },
      });
      await abuse.decayOnce();
      expect((await record(userId)).strikeCount).toBe(3);
    });

    it('moves lastStrikeAt forward so the next decay waits another period', async () => {
      // Otherwise one quiet period clears every strike at once, on the next tick.
      await strikeTimes(userId, 3);
      await makeQuiet(userId);
      await abuse.decayOnce();
      await abuse.decayOnce();
      expect((await record(userId)).strikeCount).toBe(2);
    });

    it('stops at the batch size', async () => {
      for (let i = 0; i < DECAY_BATCH_SIZE + 5; i += 1) {
        const user = await prisma.user.create({ data: { patreonUserId: `ab-bulk-${i}` } });
        await abuse.strike(user.id, 'RATE_LIMIT');
        await makeQuiet(user.id);
      }
      expect(await abuse.decayOnce()).toBe(DECAY_BATCH_SIZE);
    });
  });
});
