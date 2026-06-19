import {
  applyJitter,
  baseBackoffMs,
  backoffDelayMs,
  BACKOFF_SCHEDULE_MS,
  buildSignedContent,
  classifyStatus,
  DEFAULT_PRIORITY,
  JITTER_RATIO,
  MAX_ATTEMPTS,
  priorityFor,
  signPayload,
} from '../webhook/webhook.constants';

describe('webhook constants — priority ordering', () => {
  it('maps payment.confirmed to the highest priority (1)', () => {
    expect(priorityFor('payment.confirmed')).toBe(1);
  });

  it('maps session.expired and payment.failed to priority 2', () => {
    expect(priorityFor('session.expired')).toBe(2);
    expect(priorityFor('payment.failed')).toBe(2);
  });

  it('maps session.created and session.cancelled to priority 3', () => {
    expect(priorityFor('session.created')).toBe(3);
    expect(priorityFor('session.cancelled')).toBe(3);
  });

  it('falls back to the default priority for unknown events', () => {
    expect(priorityFor('unknown.event')).toBe(DEFAULT_PRIORITY);
  });

  it('orders events so payment.confirmed sorts before lower-priority events', () => {
    const events = ['session.created', 'payment.confirmed', 'session.expired'];
    const sorted = [...events].sort((a, b) => priorityFor(a) - priorityFor(b));
    expect(sorted).toEqual(['payment.confirmed', 'session.expired', 'session.created']);
  });
});

describe('webhook constants — retry backoff', () => {
  it('follows the 1m → 5m → 30m → 2h → 12h schedule', () => {
    expect(baseBackoffMs(1)).toBe(60_000);
    expect(baseBackoffMs(2)).toBe(5 * 60_000);
    expect(baseBackoffMs(3)).toBe(30 * 60_000);
    expect(baseBackoffMs(4)).toBe(120 * 60_000);
    expect(baseBackoffMs(5)).toBe(720 * 60_000);
  });

  it('clamps attempts beyond the schedule to the final (steady-state) interval', () => {
    const last = BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
    expect(baseBackoffMs(99)).toBe(last);
    expect(baseBackoffMs(0)).toBe(BACKOFF_SCHEDULE_MS[0]);
  });

  it('exposes a 5-attempt cap', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BACKOFF_SCHEDULE_MS).toHaveLength(MAX_ATTEMPTS);
  });

  it('applies jitter within ±20% of the base interval', () => {
    const base = 60_000;
    expect(applyJitter(base, () => 0)).toBe(Math.round(base * (1 - JITTER_RATIO))); // min
    expect(applyJitter(base, () => 1)).toBe(Math.round(base * (1 + JITTER_RATIO))); // max
    expect(applyJitter(base, () => 0.5)).toBe(base); // mid
  });

  it('keeps random jitter inside the ±20% envelope across many samples', () => {
    const base = baseBackoffMs(3);
    for (let i = 0; i < 1000; i++) {
      const d = backoffDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(Math.round(base * (1 - JITTER_RATIO)));
      expect(d).toBeLessThanOrEqual(Math.round(base * (1 + JITTER_RATIO)));
    }
  });
});

describe('webhook constants — HTTP status classification', () => {
  it('treats 2xx as success', () => {
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(204)).toBe('success');
  });

  it('dead-letters generic 4xx without retrying', () => {
    expect(classifyStatus(400)).toBe('dead');
    expect(classifyStatus(404)).toBe('dead');
    expect(classifyStatus(422)).toBe('dead');
  });

  it('retries 408 and 429 (transient client responses)', () => {
    expect(classifyStatus(408)).toBe('retry');
    expect(classifyStatus(429)).toBe('retry');
  });

  it('retries all 5xx server errors', () => {
    expect(classifyStatus(500)).toBe('retry');
    expect(classifyStatus(503)).toBe('retry');
  });
});

describe('webhook constants — signing', () => {
  it('signs over delivery_id + timestamp + payload', () => {
    const content = buildSignedContent('id-1', '2026-01-01T00:00:00.000Z', '{"a":1}');
    expect(content).toBe('id-1.2026-01-01T00:00:00.000Z.{"a":1}');
  });

  it('produces a stable, deterministic HMAC for identical inputs', () => {
    const a = signPayload('secret', 'id-1', 'ts', 'body');
    const b = signPayload('secret', 'id-1', 'ts', 'body');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the signature when any signed field changes', () => {
    const base = signPayload('secret', 'id-1', 'ts', 'body');
    expect(signPayload('secret', 'id-2', 'ts', 'body')).not.toBe(base);
    expect(signPayload('secret', 'id-1', 'ts2', 'body')).not.toBe(base);
    expect(signPayload('secret', 'id-1', 'ts', 'body2')).not.toBe(base);
    expect(signPayload('other', 'id-1', 'ts', 'body')).not.toBe(base);
  });
});
