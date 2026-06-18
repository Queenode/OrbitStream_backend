import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const CURSOR_TTL_S = 86_400; // 24 hours
const LOCK_TTL_S = 30; // 30 seconds — longer than the 3s poll interval
const CHECKPOINT_MAX = 50;
export const PERSIST_EVERY = 10;

/**
 * Atomic compare-and-swap: only update the cursor if the stored value
 * matches `expected` (or the key doesn't exist yet).
 */
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] or current == false then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
`;

@Injectable()
export class PaymentCursorService {
  private readonly logger = new Logger(PaymentCursorService.name);

  constructor(private readonly redis: RedisService) {}

  // ── Key helpers ─────────────────────────────────────────────────────────────

  cursorKey(account: string): string {
    return `orbitstream:payment_cursor:${account}`;
  }

  lockKey(account: string): string {
    return `orbitstream:payment_lock:${account}`;
  }

  checkpointKey(account: string): string {
    return `orbitstream:payment_checkpoint:${account}`;
  }

  // ── Cursor ──────────────────────────────────────────────────────────────────

  /**
   * Restore the cursor from Redis. If none is stored, returns 'now' and logs a warning.
   * If the stored cursor is ahead of the latest checkpoint, rolls back to the checkpoint
   * to guarantee at-least-once delivery.
   */
  async restoreCursor(account: string): Promise<string> {
    const stored = await this.redis.getClient().get(this.cursorKey(account));
    if (!stored) {
      this.logger.warn(
        `No cursor found in Redis for ${account} — starting from "now". Payments before this point will not be replayed.`,
      );
      return 'now';
    }

    const checkpoint = await this.getLatestCheckpoint(account);
    if (checkpoint && this.isAhead(stored, checkpoint)) {
      this.logger.warn(
        `Cursor ${stored} is ahead of checkpoint ${checkpoint} for ${account} — rolling back to safe checkpoint`,
      );
      return checkpoint;
    }

    this.logger.log(`Restored cursor for ${account}: ${stored}`);
    return stored;
  }

  /**
   * Atomically update the cursor only if `expected` still matches what's stored.
   * Returns true if the update was applied; false if another instance raced ahead.
   */
  async updateCursor(account: string, expected: string, next: string): Promise<boolean> {
    const result = await this.redis
      .getClient()
      .eval(CAS_SCRIPT, 1, this.cursorKey(account), expected, next, String(CURSOR_TTL_S));
    return result === 1;
  }

  // ── Checkpoint ──────────────────────────────────────────────────────────────

  /**
   * Append a successfully-processed paging token to the checkpoint log.
   * The list is capped at CHECKPOINT_MAX entries (oldest are dropped).
   */
  async appendCheckpoint(account: string, pagingToken: string): Promise<void> {
    const key = this.checkpointKey(account);
    const client = this.redis.getClient();
    await client.lpush(key, pagingToken);
    await client.ltrim(key, 0, CHECKPOINT_MAX - 1);
    await client.expire(key, CURSOR_TTL_S);
  }

  /** Returns the most recent safe checkpoint token, or null if none exists. */
  async getLatestCheckpoint(account: string): Promise<string | null> {
    const items = await this.redis.getClient().lrange(this.checkpointKey(account), 0, 0);
    return items[0] ?? null;
  }

  // ── Distributed lock ─────────────────────────────────────────────────────────

  /**
   * Try to acquire the distributed lock using SET NX EX.
   * Returns true if this instance now holds the lock.
   */
  async acquireLock(account: string, instanceId: string): Promise<boolean> {
    const result = await this.redis
      .getClient()
      .set(this.lockKey(account), instanceId, 'EX', LOCK_TTL_S, 'NX');
    return result === 'OK';
  }

  /**
   * Renew the lock TTL if this instance still holds it.
   * Returns false if the lock was lost (another instance took over).
   */
  async renewLock(account: string, instanceId: string): Promise<boolean> {
    const holder = await this.redis.getClient().get(this.lockKey(account));
    if (holder !== instanceId) return false;
    await this.redis.getClient().expire(this.lockKey(account), LOCK_TTL_S);
    return true;
  }

  /** Release the lock only if this instance holds it. */
  async releaseLock(account: string, instanceId: string): Promise<void> {
    const holder = await this.redis.getClient().get(this.lockKey(account));
    if (holder === instanceId) {
      await this.redis.getClient().del(this.lockKey(account));
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  /** Paging tokens are numeric strings. Returns true if a > b. */
  isAhead(a: string, b: string): boolean {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na > nb;
  }
}
