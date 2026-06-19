import * as crypto from 'crypto';

/** Redis key namespace for all webhook-queue state. */
export const WEBHOOK_NS = 'orbitstream:webhook';

/** Bull-style queue names (kept for parity with the spec / observability). */
export const WEBHOOK_QUEUE = 'webhook-delivery';
export const WEBHOOK_DEAD_LETTER_QUEUE = 'webhook-dead-letter';

/** HTTP request timeout for a single delivery attempt. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Maximum number of delivery attempts before an entry is dead-lettered. */
export const MAX_ATTEMPTS = 5;

/**
 * TTL applied to every Redis queue key (job hashes, per-session zsets, sequence
 * counters). Comfortably exceeds the full retry lifecycle (~1m+5m+30m+2h+12h ≈
 * 14.6h) so live jobs are never reaped, while orphaned keys from a crash mid-
 * `process()` are reclaimed automatically instead of leaking forever.
 */
export const WEBHOOK_KEY_TTL_S = 48 * 60 * 60; // 48 hours

/**
 * Retry backoff schedule (milliseconds), one entry per failed attempt:
 *   attempt 1 → 1min, 2 → 5min, 3 → 30min, 4 → 2hr, 5 → 12hr.
 * The final value acts as the steady-state cap.
 */
export const BACKOFF_SCHEDULE_MS = [
  1 * 60_000,
  5 * 60_000,
  30 * 60_000,
  120 * 60_000,
  720 * 60_000,
];

/** Proportion of random jitter applied to every backoff interval (±20%). */
export const JITTER_RATIO = 0.2;

/**
 * Event → priority mapping. Lower number = processed first.
 *   payment.confirmed → 1 (merchants need this to fulfill orders)
 *   session.expired / payment.failed → 2
 *   session.created / session.cancelled → 3
 */
export const EVENT_PRIORITY: Record<string, number> = {
  'payment.confirmed': 1,
  'session.expired': 2,
  'payment.failed': 2,
  'session.created': 3,
  'session.cancelled': 3,
};

export const DEFAULT_PRIORITY = 3;

export function priorityFor(event: string): number {
  return EVENT_PRIORITY[event] ?? DEFAULT_PRIORITY;
}

/**
 * Deterministic base backoff for a given (1-indexed) attempt number, clamped to
 * the last scheduled interval. Pure and side-effect free for easy unit testing.
 */
export function baseBackoffMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1), BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[idx];
}

/**
 * Apply ±JITTER_RATIO random jitter to a base interval to avoid a thundering
 * herd of simultaneous retries. `rand` is injectable for deterministic tests.
 */
export function applyJitter(baseMs: number, rand: () => number = Math.random): number {
  const offset = (rand() * 2 - 1) * JITTER_RATIO; // [-JITTER_RATIO, +JITTER_RATIO]
  return Math.round(baseMs * (1 + offset));
}

/** Full backoff for an attempt: base schedule + jitter. */
export function backoffDelayMs(attempt: number, rand: () => number = Math.random): number {
  return applyJitter(baseBackoffMs(attempt), rand);
}

export type DeliveryOutcome = 'success' | 'retry' | 'dead';

/**
 * Classify an HTTP response status into a delivery outcome.
 *   2xx              → success
 *   408 / 429        → retry (transient, endpoint is not "broken")
 *   other 4xx        → dead (merchant endpoint is broken — do not retry)
 *   5xx / everything → retry
 */
export function classifyStatus(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'dead';
  return 'retry';
}

/**
 * Signed content covers delivery_id + timestamp + payload so that a merchant can
 * verify authenticity and dedupe replays. Format: `${id}.${timestamp}.${body}`.
 */
export function buildSignedContent(deliveryId: string, timestamp: string, payload: string): string {
  return `${deliveryId}.${timestamp}.${payload}`;
}

export function signPayload(
  secret: string,
  deliveryId: string,
  timestamp: string,
  payload: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(buildSignedContent(deliveryId, timestamp, payload))
    .digest('hex');
}
