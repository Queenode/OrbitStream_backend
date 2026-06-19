import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { merchants, webhookDeadLetters, webhookDeliveries } from '../db/schema';
import { RedisService } from '../redis/redis.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import {
  backoffDelayMs,
  MAX_ATTEMPTS,
  priorityFor,
  WEBHOOK_KEY_TTL_S,
  WEBHOOK_NS,
} from './webhook.constants';

export interface EnqueueParams {
  merchantId: string;
  event: string;
  /** The full payload object that will be JSON-serialized as the request body. */
  body: Record<string, any>;
  /** Checkout session this event belongs to, if any (drives ordering). */
  sessionId?: string | null;
}

interface QueueJob {
  id: string; // == deliveryId
  merchantId: string;
  sessionId: string; // '' when none
  event: string;
  priority: number;
  sequence: number;
  payload: string; // serialized body
  deliveryId: string;
  timestamp: string; // ISO 8601, stable across retries (idempotency)
  attempt: number; // attempts already made
  availableAt: number; // epoch ms
}

interface AttemptLogEntry {
  attempt: number;
  timestamp: string;
  status: number | null;
  error: string | null;
}

/**
 * Redis-backed webhook delivery queue with priority scheduling, exponential
 * backoff + jitter retries, per-session ordering, and a dead-letter queue.
 *
 * Scheduling model (all state in Redis so it survives restarts):
 *   - `scheduled`     zset: jobId → availableAt(ms). The master "due" timeline.
 *   - `session:{sid}` zset: jobId → sequence. Orders jobs within one session.
 *   - `job:{id}`      hash: the serialized job.
 *
 * A single in-process worker polls `scheduled`, and for each due job enforces:
 *   1. at most one in-flight job per session, and
 *   2. strict sequence ordering (only the lowest-sequence job of a session runs),
 * so webhooks for the same session always arrive in order.
 */
@Injectable()
export class WebhookQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookQueueService.name);

  private readonly pollMs = Number(process.env.WEBHOOK_POLL_MS ?? 250);
  private maxConcurrency = Number(process.env.WEBHOOK_MAX_CONCURRENCY ?? 100);

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private active = 0;
  private readonly inflightSessions = new Set<string>();
  private readonly processing = new Set<string>();
  /** In-flight processing promises — lets tests await full settlement. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly redis: RedisService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.WEBHOOK_WORKER_DISABLED === 'true') {
      this.logger.log('Webhook worker auto-start disabled');
      return;
    }
    // Recover any deliveries whose Redis job was lost to a crash before starting
    // the poll loop (closes the non-transactional DB+Redis enqueue gap).
    void this.recoverPending().catch((err) =>
      this.logger.error(`Webhook recovery sweep failed: ${err?.message}`),
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.logger.log(
      `Webhook worker started (poll=${this.pollMs}ms, concurrency=${this.maxConcurrency})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Keys ─────────────────────────────────────────────────────────────────────

  private scheduledKey(): string {
    return `${WEBHOOK_NS}:scheduled`;
  }
  private jobKey(jobId: string): string {
    return `${WEBHOOK_NS}:job:${jobId}`;
  }
  private sessionKey(sessionId: string): string {
    return `${WEBHOOK_NS}:session:${sessionId}`;
  }
  private seqKey(sessionId: string): string {
    return `${WEBHOOK_NS}:seq:${sessionId}`;
  }

  // ── Enqueue ──────────────────────────────────────────────────────────────────

  /**
   * Persist a webhook delivery row and enqueue the job. The delivery id and
   * timestamp are assigned once and reused across every retry so that the HMAC
   * signature is stable and merchants can dedupe replays.
   */
  async enqueue(params: EnqueueParams): Promise<string> {
    const client = this.redis.getClient();
    const sessionId = params.sessionId ?? '';
    const deliveryId = uuidv4();
    const timestamp = new Date().toISOString();
    const priority = priorityFor(params.event);
    const payload = JSON.stringify({
      event: params.event,
      data: params.body,
      timestamp,
    });

    // Per-session monotonic sequence (0 when the event has no session).
    let sequence = 0;
    if (sessionId) {
      sequence = await client.incr(this.seqKey(sessionId));
      await client.expire(this.seqKey(sessionId), WEBHOOK_KEY_TTL_S);
    }
    const now = Date.now();

    // The DB row is the durable record of intent; the Redis job is the work item.
    // These two writes are not transactional (Redis ≠ Postgres), but the deliveryId
    // is UNIQUE so inserts are idempotent, and `recoverPending()` (run on startup)
    // re-enqueues any 'pending'/'failed' row that lost its Redis job to a crash.
    await db.insert(webhookDeliveries).values({
      merchantId: params.merchantId,
      sessionId: sessionId || null,
      event: params.event,
      payload: { event: params.event, data: params.body },
      deliveryId,
      sequence,
      priority,
      status: 'pending',
      attempts: 0,
      attemptLog: [],
    } as any);

    const job: QueueJob = {
      id: deliveryId,
      merchantId: params.merchantId,
      sessionId,
      event: params.event,
      priority,
      sequence,
      payload,
      deliveryId,
      timestamp,
      attempt: 0,
      availableAt: now,
    };

    await this.writeJob(job);
    if (sessionId) {
      await client.zadd(this.sessionKey(sessionId), String(sequence), job.id);
      await client.expire(this.sessionKey(sessionId), WEBHOOK_KEY_TTL_S);
    }
    // Added last: this is the dispatch trigger, so the job is only ever made
    // runnable once its hash and session-ordering entry are both in place.
    await client.zadd(this.scheduledKey(), String(now), job.id);

    this.logger.log(
      `Enqueued ${params.event} (delivery=${deliveryId}, priority=${priority}` +
        (sessionId ? `, session=${sessionId}, seq=${sequence})` : ')'),
    );
    return deliveryId;
  }

  private async writeJob(job: QueueJob): Promise<void> {
    const client = this.redis.getClient();
    await client.hset(this.jobKey(job.id), {
      id: job.id,
      merchantId: job.merchantId,
      sessionId: job.sessionId,
      event: job.event,
      priority: String(job.priority),
      sequence: String(job.sequence),
      payload: job.payload,
      deliveryId: job.deliveryId,
      timestamp: job.timestamp,
      attempt: String(job.attempt),
      availableAt: String(job.availableAt),
    });
    // TTL is refreshed on every write (initial enqueue + each retry) so a job in
    // its normal lifecycle never expires, but a hash orphaned by a crash does.
    await client.expire(this.jobKey(job.id), WEBHOOK_KEY_TTL_S);
  }

  private async readJob(jobId: string): Promise<QueueJob | null> {
    const h = await this.redis.getClient().hgetall(this.jobKey(jobId));
    if (!h || !h.id) return null;
    return {
      id: h.id,
      merchantId: h.merchantId,
      sessionId: h.sessionId ?? '',
      event: h.event,
      priority: Number(h.priority),
      sequence: Number(h.sequence),
      payload: h.payload,
      deliveryId: h.deliveryId,
      timestamp: h.timestamp,
      attempt: Number(h.attempt),
      availableAt: Number(h.availableAt),
    };
  }

  // ── Scheduling tick ────────────────────────────────────────────────────────────

  /**
   * One scheduling pass: pick the highest-priority, in-order, due jobs that
   * respect per-session serialization and dispatch them up to the concurrency
   * limit. Returns the number of jobs dispatched (useful for tests).
   */
  async tick(now = Date.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const capacity = this.maxConcurrency - this.active;
      if (capacity <= 0) return 0;

      const client = this.redis.getClient();
      const dueIds: string[] = await client.zrangebyscore(this.scheduledKey(), '-inf', now);
      if (dueIds.length === 0) return 0;

      const candidates: QueueJob[] = [];
      for (const jobId of dueIds) {
        if (this.processing.has(jobId)) continue;
        const job = await this.readJob(jobId);
        if (!job) {
          await client.zrem(this.scheduledKey(), jobId);
          continue;
        }
        if (job.sessionId) {
          if (this.inflightSessions.has(job.sessionId)) continue;
          // Strict ordering: only the lowest-sequence job of a session may run.
          const head = await client.zrange(this.sessionKey(job.sessionId), 0, 0);
          if (head[0] !== job.id) continue;
        }
        candidates.push(job);
      }

      candidates.sort(
        (a, b) =>
          a.priority - b.priority || a.sequence - b.sequence || a.availableAt - b.availableAt,
      );

      let dispatched = 0;
      for (const job of candidates) {
        if (dispatched >= capacity) break;
        // Re-check session contention against earlier picks in this same pass.
        if (job.sessionId && this.inflightSessions.has(job.sessionId)) continue;

        this.processing.add(job.id);
        if (job.sessionId) this.inflightSessions.add(job.sessionId);
        this.active++;
        dispatched++;
        const p = this.process(job)
          .catch((err) =>
            this.logger.error(`Unhandled webhook job error (${job.id}): ${err?.message}`),
          )
          .finally(() => this.pending.delete(p));
        this.pending.add(p);
      }
      return dispatched;
    } finally {
      this.ticking = false;
    }
  }

  /** Resolve once every currently in-flight delivery has settled (test helper). */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // ── Job processing ─────────────────────────────────────────────────────────────

  private async process(job: QueueJob): Promise<void> {
    try {
      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, job.merchantId),
      });
      if (!merchant?.webhookUrl || !merchant?.webhookSecret) {
        this.logger.debug(`No webhook target for merchant ${job.merchantId}; dropping ${job.id}`);
        await this.cleanup(job);
        return;
      }

      const result = await this.delivery.deliver(
        { url: merchant.webhookUrl, secret: merchant.webhookSecret },
        {
          deliveryId: job.deliveryId,
          timestamp: job.timestamp,
          event: job.event,
          sequence: job.sequence,
          payload: job.payload,
        },
      );

      const attemptNo = job.attempt + 1;
      const entry: AttemptLogEntry = {
        attempt: attemptNo,
        timestamp: new Date().toISOString(),
        status: result.status,
        error: result.error,
      };

      if (result.outcome === 'success') {
        await this.recordDelivery(job, 'delivered', attemptNo, result.status, entry, null);
        await this.cleanup(job);
        this.logger.log(`Webhook delivered: ${job.event} (${job.deliveryId})`);
        return;
      }

      if (result.outcome === 'dead') {
        await this.recordDelivery(job, 'dead', attemptNo, result.status, entry, null);
        await this.deadLetter(job, `4xx:${result.status}`, entry);
        return;
      }

      // retry
      if (attemptNo >= MAX_ATTEMPTS) {
        await this.recordDelivery(job, 'dead', attemptNo, result.status, entry, null);
        await this.deadLetter(job, 'max_attempts', entry);
        return;
      }

      const delay = backoffDelayMs(attemptNo);
      const availableAt = Date.now() + delay;
      await this.recordDelivery(
        job,
        'failed',
        attemptNo,
        result.status,
        entry,
        new Date(availableAt),
      );
      job.attempt = attemptNo;
      job.availableAt = availableAt;
      await this.writeJob(job);
      // Keep the job in the session zset so later events wait for it (ordering).
      await this.redis.getClient().zadd(this.scheduledKey(), String(availableAt), job.id);
      this.logger.warn(
        `Webhook ${job.event} (${job.deliveryId}) retry ${attemptNo}/${MAX_ATTEMPTS} in ${delay}ms`,
      );
    } finally {
      if (job.sessionId) this.inflightSessions.delete(job.sessionId);
      this.processing.delete(job.id);
      this.active = Math.max(0, this.active - 1);
    }
  }

  /** Remove all Redis traces of a finished job. */
  private async cleanup(job: QueueJob): Promise<void> {
    const client = this.redis.getClient();
    await client.zrem(this.scheduledKey(), job.id);
    if (job.sessionId) await client.zrem(this.sessionKey(job.sessionId), job.id);
    await client.del(this.jobKey(job.id));
  }

  private async deadLetter(
    job: QueueJob,
    reason: string,
    lastEntry: AttemptLogEntry,
  ): Promise<void> {
    const row = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.deliveryId, job.deliveryId),
    });
    await db.insert(webhookDeadLetters).values({
      merchantId: job.merchantId,
      deliveryId: job.deliveryId,
      sessionId: job.sessionId || null,
      event: job.event,
      payload: row?.payload ?? { event: job.event },
      attempts: (row?.attemptLog as any) ?? [lastEntry],
      reason,
    } as any);
    await this.cleanup(job);
    this.logger.error(`Webhook ${job.event} (${job.deliveryId}) dead-lettered: ${reason}`);
  }

  private async recordDelivery(
    job: QueueJob,
    status: 'delivered' | 'failed' | 'dead',
    attempts: number,
    responseStatus: number | null,
    entry: AttemptLogEntry,
    nextRetryAt: Date | null,
  ): Promise<void> {
    const row = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.deliveryId, job.deliveryId),
    });
    const log = [...((row?.attemptLog as AttemptLogEntry[]) ?? []), entry];
    await db
      .update(webhookDeliveries)
      .set({
        status,
        attempts,
        responseStatus: responseStatus ?? null,
        attemptLog: log,
        deliveredAt: status === 'delivered' ? new Date() : null,
        nextRetryAt,
      } as any)
      .where(eq(webhookDeliveries.deliveryId, job.deliveryId));
  }

  // ── Dead-letter requeue (manual retry) ──────────────────────────────────────────

  /**
   * Re-enqueue a dead-letter entry as a fresh delivery. Returns the new delivery
   * id, or null if the entry / merchant no longer exists.
   */
  async requeueDeadLetter(merchantId: string, deadLetterId: string): Promise<string | null> {
    const dead = await db.query.webhookDeadLetters.findFirst({
      where: eq(webhookDeadLetters.id, deadLetterId),
    });
    if (!dead || dead.merchantId !== merchantId) return null;

    const payload = dead.payload as { data?: Record<string, any> };
    const newId = await this.enqueue({
      merchantId,
      event: dead.event,
      body: payload?.data ?? {},
      sessionId: dead.sessionId,
    });
    await db
      .update(webhookDeadLetters)
      .set({ retriedAt: new Date() } as any)
      .where(eq(webhookDeadLetters.id, deadLetterId));
    return newId;
  }

  // ── Crash recovery ──────────────────────────────────────────────────────────────

  /**
   * Reconcile the durable DB log with the Redis queue: any delivery still in a
   * non-terminal state (`pending`/`failed`) whose Redis job is missing — e.g. the
   * process crashed between the DB insert and the Redis write — is re-enqueued.
   * Returns the number of jobs revived. Idempotent and safe to run repeatedly.
   */
  async recoverPending(): Promise<number> {
    const client = this.redis.getClient();
    const rows = await db.query.webhookDeliveries.findMany({
      where: inArray(webhookDeliveries.status, ['pending', 'failed']),
    });

    let revived = 0;
    for (const row of rows as any[]) {
      if (await client.exists(this.jobKey(row.deliveryId))) continue;
      await this.reviveFromRow(row);
      revived++;
    }
    if (revived > 0) this.logger.warn(`Recovered ${revived} orphaned webhook job(s)`);
    return revived;
  }

  /** Rebuild a Redis job from a persisted delivery row (reuses its delivery id). */
  private async reviveFromRow(row: any): Promise<void> {
    const client = this.redis.getClient();
    const sessionId: string = row.sessionId ?? '';
    const timestamp = new Date(row.createdAt ?? Date.now()).toISOString();
    const data = (row.payload as any)?.data ?? {};
    const job: QueueJob = {
      id: row.deliveryId,
      merchantId: row.merchantId,
      sessionId,
      event: row.event,
      priority: row.priority ?? priorityFor(row.event),
      sequence: row.sequence ?? 0,
      payload: JSON.stringify({ event: row.event, data, timestamp }),
      deliveryId: row.deliveryId,
      timestamp,
      attempt: row.attempts ?? 0,
      availableAt: Date.now(),
    };

    await this.writeJob(job);
    if (sessionId) {
      await client.zadd(this.sessionKey(sessionId), String(job.sequence), job.id);
      await client.expire(this.sessionKey(sessionId), WEBHOOK_KEY_TTL_S);
      // Keep the session's sequence counter ahead of any revived job.
      const cur = await client.get(this.seqKey(sessionId));
      if (!cur || Number(cur) < job.sequence) {
        await client.set(this.seqKey(sessionId), String(job.sequence), 'EX', WEBHOOK_KEY_TTL_S);
      }
    }
    await client.zadd(this.scheduledKey(), String(job.availableAt), job.id);
  }
}
