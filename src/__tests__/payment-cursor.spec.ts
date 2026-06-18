import { Test, TestingModule } from '@nestjs/testing';
import { PaymentCursorService, PERSIST_EVERY } from '../payments/payment-cursor.service';
import { RedisService } from '../redis/redis.service';
import RedisMock from 'ioredis-mock';

// ioredis-mock shares its data store across instances within a Jest worker.
// A single shared mock is created once; beforeEach flushes it to guarantee isolation.
const sharedMock = new RedisMock();
function buildRedisService(): RedisService {
  return { getClient: () => sharedMock } as unknown as RedisService;
}

describe('PaymentCursorService', () => {
  let service: PaymentCursorService;
  let redisService: RedisService;

  beforeEach(async () => {
    await sharedMock.flushall();
    redisService = buildRedisService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentCursorService, { provide: RedisService, useValue: redisService }],
    }).compile();
    service = module.get(PaymentCursorService);
  });

  const ACCOUNT = 'GABC123';

  describe('cursor storage (updateCursor / restoreCursor)', () => {
    it('returns "now" when no cursor is stored', async () => {
      const cursor = await service.restoreCursor(ACCOUNT);
      expect(cursor).toBe('now');
    });

    it('stores and restores a cursor', async () => {
      await service.updateCursor(ACCOUNT, 'now', '100000');
      const cursor = await service.restoreCursor(ACCOUNT);
      expect(cursor).toBe('100000');
    });

    it('CAS rejects update when expected does not match current', async () => {
      await service.updateCursor(ACCOUNT, 'now', '100000');
      const ok = await service.updateCursor(ACCOUNT, '999', '200000');
      expect(ok).toBe(false);
      // cursor must still be the original value
      const cursor = await service.restoreCursor(ACCOUNT);
      expect(cursor).toBe('100000');
    });

    it('CAS accepts update when expected matches current', async () => {
      await service.updateCursor(ACCOUNT, 'now', '100000');
      const ok = await service.updateCursor(ACCOUNT, '100000', '200000');
      expect(ok).toBe(true);
      const cursor = await service.restoreCursor(ACCOUNT);
      expect(cursor).toBe('200000');
    });
  });

  describe('lock acquisition and contention', () => {
    const INSTANCE_A = 'instance-a';
    const INSTANCE_B = 'instance-b';

    it('acquires lock when key is free', async () => {
      const got = await service.acquireLock(ACCOUNT, INSTANCE_A);
      expect(got).toBe(true);
    });

    it('second instance cannot acquire lock held by first', async () => {
      await service.acquireLock(ACCOUNT, INSTANCE_A);
      const got = await service.acquireLock(ACCOUNT, INSTANCE_B);
      expect(got).toBe(false);
    });

    it('renews lock for the holder', async () => {
      await service.acquireLock(ACCOUNT, INSTANCE_A);
      const renewed = await service.renewLock(ACCOUNT, INSTANCE_A);
      expect(renewed).toBe(true);
    });

    it('renew fails for non-holder', async () => {
      await service.acquireLock(ACCOUNT, INSTANCE_A);
      const renewed = await service.renewLock(ACCOUNT, INSTANCE_B);
      expect(renewed).toBe(false);
    });

    it('releases lock and allows re-acquisition', async () => {
      await service.acquireLock(ACCOUNT, INSTANCE_A);
      await service.releaseLock(ACCOUNT, INSTANCE_A);
      const got = await service.acquireLock(ACCOUNT, INSTANCE_B);
      expect(got).toBe(true);
    });

    it('non-holder cannot release lock', async () => {
      await service.acquireLock(ACCOUNT, INSTANCE_A);
      await service.releaseLock(ACCOUNT, INSTANCE_B); // should be a no-op
      const renewed = await service.renewLock(ACCOUNT, INSTANCE_A);
      expect(renewed).toBe(true); // still held by A
    });
  });

  describe('checkpoint replay', () => {
    it('returns null when no checkpoint exists', async () => {
      const cp = await service.getLatestCheckpoint(ACCOUNT);
      expect(cp).toBeNull();
    });

    it('returns the most recently appended token', async () => {
      await service.appendCheckpoint(ACCOUNT, '100');
      await service.appendCheckpoint(ACCOUNT, '200');
      await service.appendCheckpoint(ACCOUNT, '300');
      const cp = await service.getLatestCheckpoint(ACCOUNT);
      expect(cp).toBe('300');
    });

    it('rolls back cursor to checkpoint if cursor is ahead', async () => {
      await service.appendCheckpoint(ACCOUNT, '500');
      // store a cursor that is ahead of the checkpoint
      await service.updateCursor(ACCOUNT, 'now', '900');
      // restoreCursor should detect the discrepancy and return the checkpoint
      const cursor = await service.restoreCursor(ACCOUNT);
      expect(cursor).toBe('500');
    });

    it('keeps cursor when it is not ahead of checkpoint', async () => {
      await service.appendCheckpoint(ACCOUNT, '900');
      await service.updateCursor(ACCOUNT, 'now', '500');
      const cursor = await service.restoreCursor(ACCOUNT);
      expect(cursor).toBe('500');
    });
  });

  describe('PERSIST_EVERY constant', () => {
    it('is exported and equals 10', () => {
      expect(PERSIST_EVERY).toBe(10);
    });
  });

  describe('crash recovery simulation', () => {
    it('replays from last flush point after a partial-batch crash (< PERSIST_EVERY ops)', async () => {
      // Establish a stable flush point at '1000'
      await service.updateCursor(ACCOUNT, 'now', '1000');
      await service.appendCheckpoint(ACCOUNT, '1000');

      // 3 more ops checkpointed but cursor NOT flushed yet (batch < PERSIST_EVERY=10)
      for (const token of ['1100', '1200', '1300']) {
        await service.appendCheckpoint(ACCOUNT, token);
      }

      // Simulate restart: new service instance backed by the SAME Redis mock
      const restarted = (
        await Test.createTestingModule({
          providers: [PaymentCursorService, { provide: RedisService, useValue: redisService }],
        }).compile()
      ).get(PaymentCursorService);

      // cursor='1000' is NOT ahead of checkpoint='1300' → returns '1000' (safe replay point)
      const cursor = await restarted.restoreCursor(ACCOUNT);
      expect(cursor).toBe('1000');
    });

    it('rolls back to checkpoint when stored cursor is unexpectedly ahead', async () => {
      // cursor was flushed to '2000' but checkpoint list only reached '1500'
      await service.updateCursor(ACCOUNT, 'now', '2000');
      await service.appendCheckpoint(ACCOUNT, '1500');

      const restarted = (
        await Test.createTestingModule({
          providers: [PaymentCursorService, { provide: RedisService, useValue: redisService }],
        }).compile()
      ).get(PaymentCursorService);

      // '2000' IS ahead of '1500' → rolls back to safe checkpoint '1500'
      const cursor = await restarted.restoreCursor(ACCOUNT);
      expect(cursor).toBe('1500');
    });

    it('returns "now" when neither cursor nor checkpoint survived the crash', async () => {
      // Fresh Redis state — nothing stored
      const restarted = (
        await Test.createTestingModule({
          providers: [PaymentCursorService, { provide: RedisService, useValue: redisService }],
        }).compile()
      ).get(PaymentCursorService);

      const cursor = await restarted.restoreCursor(ACCOUNT);
      expect(cursor).toBe('now');
    });
  });

  describe('full persist-and-restore integration flow', () => {
    it('restores the exact cursor after one complete PERSIST_EVERY flush cycle', async () => {
      let currentCursor = 'now';

      for (let i = 1; i <= PERSIST_EVERY; i++) {
        const token = String(i * 100);
        await service.appendCheckpoint(ACCOUNT, token);
        if (i === PERSIST_EVERY) {
          await service.updateCursor(ACCOUNT, currentCursor, token);
          currentCursor = token;
        }
      }

      const restarted = (
        await Test.createTestingModule({
          providers: [PaymentCursorService, { provide: RedisService, useValue: redisService }],
        }).compile()
      ).get(PaymentCursorService);

      expect(await restarted.restoreCursor(ACCOUNT)).toBe('1000');
    });

    it('persists the latest cursor across multiple flush cycles', async () => {
      let currentCursor = 'now';

      for (let i = 1; i <= PERSIST_EVERY * 2; i++) {
        const token = String(i * 100);
        await service.appendCheckpoint(ACCOUNT, token);
        if (i % PERSIST_EVERY === 0) {
          await service.updateCursor(ACCOUNT, currentCursor, token);
          currentCursor = token;
        }
      }

      const restarted = (
        await Test.createTestingModule({
          providers: [PaymentCursorService, { provide: RedisService, useValue: redisService }],
        }).compile()
      ).get(PaymentCursorService);

      // Second cycle flushed at op 20 → token '2000'
      expect(await restarted.restoreCursor(ACCOUNT)).toBe('2000');
    });

    it('CAS prevents a stale replica from overwriting a newer cursor', async () => {
      const ok0 = await service.updateCursor(ACCOUNT, 'now', '100000');
      expect(ok0).toBe(true);

      // Replica A advances correctly
      const okA = await service.updateCursor(ACCOUNT, '100000', '200000');
      expect(okA).toBe(true);

      // Stale replica B tries to write from the old value — must be rejected
      const okB = await service.updateCursor(ACCOUNT, '100000', '300000');
      expect(okB).toBe(false);

      // Cursor must reflect A's update, not B's
      expect(await service.restoreCursor(ACCOUNT)).toBe('200000');
    });
  });

  describe('rate-limit 429 backoff (isAhead helper)', () => {
    it('returns true when a is numerically greater than b', () => {
      expect(service.isAhead('200', '100')).toBe(true);
    });

    it('returns false when a equals b', () => {
      expect(service.isAhead('100', '100')).toBe(false);
    });

    it('returns false when a is less than b', () => {
      expect(service.isAhead('50', '100')).toBe(false);
    });

    it('handles large paging token strings without precision loss', () => {
      const large = '179769313486231570000';
      const larger = '179769313486231570001';
      expect(service.isAhead(larger, large)).toBe(true);
      expect(service.isAhead(large, larger)).toBe(false);
    });
  });
});
