// ── Mock drizzle + db so the queue's persistence is an in-memory store ──────────
jest.mock('drizzle-orm', () => ({
  eq: (col: string, val: any) => ({ op: 'eq', col, val }),
  and: (...conds: any[]) => ({ op: 'and', conds }),
  desc: (col: string) => ({ op: 'desc', col }),
  lte: (col: string, val: any) => ({ op: 'lte', col, val }),
  inArray: (col: string, vals: any[]) => ({ op: 'inArray', col, vals }),
}));

jest.mock('../db/schema', () => ({
  merchants: { __name: 'merchants', id: 'id' },
  webhookDeliveries: {
    __name: 'deliveries',
    deliveryId: 'deliveryId',
    merchantId: 'merchantId',
    createdAt: 'createdAt',
  },
  webhookDeadLetters: {
    __name: 'deadLetters',
    id: 'id',
    merchantId: 'merchantId',
    createdAt: 'createdAt',
  },
}));

jest.mock('../db/index', () => {
  const store: any = { merchant: null, deliveries: [], deadLetters: [] };
  (globalThis as any).__whStore = store;

  const matches = (row: any, cond: any): boolean => {
    if (cond.op === 'and') return cond.conds.every((c: any) => matches(row, c));
    if (cond.op === 'eq') return row[cond.col] === cond.val;
    return false;
  };

  const db = {
    query: {
      merchants: { findFirst: async () => store.merchant },
      webhookDeliveries: {
        findFirst: async ({ where }: any) =>
          store.deliveries.find((r: any) => matches(r, where)) ?? null,
        findMany: async () => store.deliveries,
      },
      webhookDeadLetters: {
        findFirst: async ({ where }: any) =>
          store.deadLetters.find((r: any) => matches(r, where)) ?? null,
        findMany: async () => store.deadLetters,
      },
    },
    insert: (table: any) => ({
      values: (v: any) => {
        const arr = store[table.__name];
        const row = { id: `${table.__name}-${arr.length + 1}`, ...v };
        arr.push(row);
        return Promise.resolve([row]);
      },
    }),
    update: (table: any) => ({
      set: (vals: any) => ({
        where: (cond: any) => {
          for (const row of store[table.__name]) {
            if (matches(row, cond)) Object.assign(row, vals);
          }
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db, schema: {} };
});

import RedisMock from 'ioredis-mock';
import { WebhookQueueService } from '../webhook/webhook-queue.service';
import { RedisService } from '../redis/redis.service';

const sharedMock = new RedisMock();
const redisService = { getClient: () => sharedMock } as unknown as RedisService;

function store() {
  return (globalThis as any).__whStore;
}

/** Programmable delivery double. */
function makeDelivery() {
  const calls: any[] = [];
  let responder: (req: any) => {
    outcome: string;
    status: number | null;
    error: string | null;
  } = () => ({
    outcome: 'success',
    status: 200,
    error: null,
  });
  return {
    calls,
    setResponder(fn: typeof responder) {
      responder = fn;
    },
    deliver: jest.fn(async (_target: any, req: any) => {
      calls.push(req);
      return responder(req);
    }),
  };
}

const MERCHANT = {
  id: 'merchant-1',
  webhookUrl: 'https://m.example/hook',
  webhookSecret: 'secret',
};

async function drain(svc: WebhookQueueService, now: number) {
  for (let i = 0; i < 200; i++) {
    const dispatched = await svc.tick(now);
    await svc.settle();
    if (dispatched === 0) break;
  }
}

describe('WebhookQueueService', () => {
  let delivery: ReturnType<typeof makeDelivery>;
  let svc: WebhookQueueService;

  beforeEach(async () => {
    await sharedMock.flushall();
    const s = store();
    s.merchant = { ...MERCHANT };
    s.deliveries.length = 0;
    s.deadLetters.length = 0;
    delivery = makeDelivery();
    svc = new WebhookQueueService(redisService, delivery as any);
  });

  describe('priority ordering', () => {
    it('dispatches higher-priority events first', async () => {
      (svc as any).maxConcurrency = 1; // force strictly serial dispatch
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'session.created', body: {} }); // p3
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'payment.confirmed', body: {} }); // p1
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'session.expired', body: {} }); // p2

      await drain(svc, Date.now());

      expect(delivery.calls.map((c) => c.event)).toEqual([
        'payment.confirmed',
        'session.expired',
        'session.created',
      ]);
    });
  });

  describe('per-session ordering', () => {
    it('delivers webhooks for the same session in sequence order', async () => {
      const sessionId = 'sess-A';
      await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'session.created',
        body: { sessionId },
        sessionId,
      });
      await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'payment.confirmed',
        body: { sessionId },
        sessionId,
      });
      await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'session.expired',
        body: { sessionId },
        sessionId,
      });

      await drain(svc, Date.now());

      // Even though payment.confirmed is higher priority, ordering wins within a session.
      expect(delivery.calls.map((c) => c.event)).toEqual([
        'session.created',
        'payment.confirmed',
        'session.expired',
      ]);
      expect(delivery.calls.map((c) => c.sequence)).toEqual([1, 2, 3]);
    });

    it('does not deliver a later session event while an earlier one is still retrying', async () => {
      const sessionId = 'sess-B';
      delivery.setResponder((req) =>
        req.sequence === 1
          ? { outcome: 'retry', status: 503, error: 'HTTP 503' }
          : { outcome: 'success', status: 200, error: null },
      );
      await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'session.created',
        body: { sessionId },
        sessionId,
      });
      await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'session.expired',
        body: { sessionId },
        sessionId,
      });

      const t0 = Date.now();
      await drain(svc, t0);

      // seq 1 failed and is parked for a future retry; seq 2 must NOT have been delivered.
      expect(delivery.calls.map((c) => c.sequence)).toEqual([1]);

      // Advance past the backoff and let seq 1 succeed → both arrive, in order.
      delivery.setResponder(() => ({ outcome: 'success', status: 200, error: null }));
      await drain(svc, t0 + 2 * 60 * 60 * 1000);
      expect(delivery.calls.map((c) => c.sequence)).toEqual([1, 1, 2]);
    });
  });

  describe('dead-letter placement', () => {
    it('dead-letters a 4xx response immediately without retrying', async () => {
      delivery.setResponder(() => ({ outcome: 'dead', status: 404, error: 'HTTP 404' }));
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'payment.confirmed', body: {} });

      await drain(svc, Date.now());

      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(store().deadLetters).toHaveLength(1);
      expect(store().deadLetters[0].reason).toBe('4xx:404');
      expect(store().deliveries[0].status).toBe('dead');
    });

    it('dead-letters after MAX_ATTEMPTS exhausted on persistent 5xx', async () => {
      delivery.setResponder(() => ({ outcome: 'retry', status: 500, error: 'HTTP 500' }));
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'payment.confirmed', body: {} });

      let now = Date.now();
      for (let i = 0; i < 6; i++) {
        await drain(svc, now);
        now += 13 * 60 * 60 * 1000; // jump past the longest (12h) backoff
      }

      expect(delivery.deliver).toHaveBeenCalledTimes(5);
      expect(store().deadLetters).toHaveLength(1);
      expect(store().deadLetters[0].reason).toBe('max_attempts');
    });
  });

  describe('idempotency', () => {
    it('reuses the same delivery id across retries of one delivery', async () => {
      let attempts = 0;
      delivery.setResponder(() =>
        ++attempts < 2
          ? { outcome: 'retry', status: 500, error: 'x' }
          : { outcome: 'success', status: 200, error: null },
      );
      const deliveryId = await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'payment.confirmed',
        body: {},
      });

      let now = Date.now();
      for (let i = 0; i < 3; i++) {
        await drain(svc, now);
        now += 2 * 60 * 1000;
      }

      expect(delivery.calls).toHaveLength(2);
      expect(delivery.calls[0].deliveryId).toBe(deliveryId);
      expect(delivery.calls[1].deliveryId).toBe(deliveryId);
    });

    it('assigns a unique uuid-v4 delivery id per enqueue', async () => {
      const id1 = await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'session.created',
        body: {},
      });
      const id2 = await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'session.created',
        body: {},
      });
      const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id1).toMatch(v4);
      expect(id2).toMatch(v4);
      expect(id1).not.toBe(id2);
    });
  });

  describe('manual dead-letter retry', () => {
    it('re-enqueues a dead-letter entry as a fresh delivery', async () => {
      delivery.setResponder(() => ({ outcome: 'dead', status: 400, error: 'HTTP 400' }));
      await svc.enqueue({
        merchantId: MERCHANT.id,
        event: 'payment.confirmed',
        body: { sessionId: 'sX' },
        sessionId: 'sX',
      });
      await drain(svc, Date.now());
      expect(store().deadLetters).toHaveLength(1);

      delivery.setResponder(() => ({ outcome: 'success', status: 200, error: null }));
      const dlId = store().deadLetters[0].id;
      const newId = await svc.requeueDeadLetter(MERCHANT.id, dlId);
      expect(newId).toBeTruthy();
      await drain(svc, Date.now());

      expect(store().deadLetters[0].retriedAt).toBeInstanceOf(Date);
      const success = delivery.calls.find((c) => c.deliveryId === newId);
      expect(success).toBeTruthy();
    });

    it('refuses to retry a dead-letter entry owned by another merchant', async () => {
      delivery.setResponder(() => ({ outcome: 'dead', status: 400, error: 'HTTP 400' }));
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'payment.confirmed', body: {} });
      await drain(svc, Date.now());
      const dlId = store().deadLetters[0].id;
      const result = await svc.requeueDeadLetter('someone-else', dlId);
      expect(result).toBeNull();
    });
  });

  describe('crash recovery (recoverPending)', () => {
    it('re-enqueues a persisted delivery whose Redis job was lost', async () => {
      // Simulate a crash after the DB insert but before the Redis write: a
      // 'pending' row exists with no corresponding job in Redis.
      store().deliveries.push({
        id: 'deliveries-1',
        deliveryId: '99999999-9999-4999-8999-999999999999',
        merchantId: MERCHANT.id,
        sessionId: null,
        event: 'payment.confirmed',
        payload: { event: 'payment.confirmed', data: { n: 1 } },
        sequence: 0,
        priority: 1,
        status: 'pending',
        attempts: 0,
        attemptLog: [],
        createdAt: new Date(),
      });

      const revived = await svc.recoverPending();
      expect(revived).toBe(1);

      await drain(svc, Date.now());

      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(delivery.calls[0].deliveryId).toBe('99999999-9999-4999-8999-999999999999');
      expect(store().deliveries[0].status).toBe('delivered');
    });

    it('does not re-enqueue a delivery that still has its Redis job', async () => {
      await svc.enqueue({ merchantId: MERCHANT.id, event: 'payment.confirmed', body: {} });
      const revived = await svc.recoverPending();
      expect(revived).toBe(0);
    });
  });

  describe('load — 100 concurrent deliveries', () => {
    it('delivers 100 independent webhooks in a single high-concurrency pass', async () => {
      for (let i = 0; i < 100; i++) {
        await svc.enqueue({
          merchantId: MERCHANT.id,
          event: 'payment.confirmed',
          body: { n: i, sessionId: `load-${i}` },
          sessionId: `load-${i}`,
        });
      }

      await drain(svc, Date.now());

      expect(delivery.deliver).toHaveBeenCalledTimes(100);
      expect(store().deadLetters).toHaveLength(0);
      expect(store().deliveries.every((d: any) => d.status === 'delivered')).toBe(true);
    });
  });
});
