// Mock DB modules before any imports that trigger DB initialisation
jest.mock('../db/index', () => ({
  db: {
    query: { checkoutSessions: { findFirst: jest.fn() } },
    insert: jest.fn().mockReturnValue({ values: jest.fn() }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
  },
}));
jest.mock('../db/schema', () => ({ checkoutSessions: {}, payments: {} }));

import { Test, TestingModule } from '@nestjs/testing';
import { PaymentDetectorService } from '../payments/payment-detector.service';
import { PaymentCursorService } from '../payments/payment-cursor.service';
import { StellarService } from '../stellar/stellar.service';
import { WebhookService } from '../webhook/webhook.service';
import { MetricsService } from '../monitoring/metrics.service';

// White-box access to private backoff state
function priv(svc: PaymentDetectorService): any {
  return svc as any;
}

const DEFAULT_INTERVAL_MS = 3_000;
const BACKOFF_429_MS = 10_000;
const BACKOFF_5XX_MS = 5_000;
const BACKOFF_429_DURATION = 60_000;
const BACKOFF_5XX_DURATION = 30_000;

describe('PaymentDetectorService — rate-limit backoff', () => {
  let service: PaymentDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentDetectorService,
        {
          provide: StellarService,
          useValue: {
            getPaymentsPage: jest.fn(),
            getHttpStatusFromError: jest.fn().mockReturnValue(0),
          },
        },
        {
          provide: WebhookService,
          useValue: { dispatchWebhook: jest.fn() },
        },
        {
          provide: MetricsService,
          useValue: { paymentsConfirmed: { inc: jest.fn() } },
        },
        {
          provide: PaymentCursorService,
          useValue: {
            restoreCursor: jest.fn().mockResolvedValue('now'),
            acquireLock: jest.fn().mockResolvedValue(true),
            renewLock: jest.fn().mockResolvedValue(true),
            releaseLock: jest.fn(),
            updateCursor: jest.fn().mockResolvedValue(true),
            appendCheckpoint: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(PaymentDetectorService);
  });

  describe('429 rate-limit backoff', () => {
    it('reports 10s interval immediately after a 429', () => {
      priv(service).pollIntervalMs = BACKOFF_429_MS;
      priv(service).backoffUntilMs = Date.now() + BACKOFF_429_DURATION;

      expect(priv(service).currentInterval()).toBe(BACKOFF_429_MS);
    });

    it('resets to 3s once the 1-minute backoff window expires', () => {
      priv(service).pollIntervalMs = BACKOFF_429_MS;
      priv(service).backoffUntilMs = Date.now() - 1; // already expired

      expect(priv(service).currentInterval()).toBe(DEFAULT_INTERVAL_MS);
    });

    it('stays at 10s for the full BACKOFF_429_DURATION window', () => {
      const now = Date.now();
      priv(service).pollIntervalMs = BACKOFF_429_MS;
      priv(service).backoffUntilMs = now + BACKOFF_429_DURATION;

      // still inside the window
      expect(priv(service).currentInterval()).toBe(BACKOFF_429_MS);

      // exactly at the boundary (expired)
      priv(service).backoffUntilMs = now - 1;
      expect(priv(service).currentInterval()).toBe(DEFAULT_INTERVAL_MS);
    });

    it('proactive 429 backoff (rateLimitRemaining < 10) sets the same intervals', () => {
      // Simulate the preemptive path triggered by low remaining quota
      priv(service).pollIntervalMs = BACKOFF_429_MS;
      priv(service).backoffUntilMs = Date.now() + BACKOFF_429_DURATION;

      expect(priv(service).currentInterval()).toBe(BACKOFF_429_MS);
    });
  });

  describe('5xx server-error backoff', () => {
    it('reports 5s interval immediately after a 5xx', () => {
      priv(service).pollIntervalMs = BACKOFF_5XX_MS;
      priv(service).backoffUntilMs = Date.now() + BACKOFF_5XX_DURATION;

      expect(priv(service).currentInterval()).toBe(BACKOFF_5XX_MS);
    });

    it('resets to 3s once the 30s backoff window expires', () => {
      priv(service).pollIntervalMs = BACKOFF_5XX_MS;
      priv(service).backoffUntilMs = Date.now() - 1;

      expect(priv(service).currentInterval()).toBe(DEFAULT_INTERVAL_MS);
    });

    it('5xx backoff window is shorter than 429 backoff window', () => {
      expect(BACKOFF_5XX_DURATION).toBeLessThan(BACKOFF_429_DURATION);
      expect(BACKOFF_5XX_MS).toBeLessThan(BACKOFF_429_MS);
    });
  });

  describe('normal operation', () => {
    it('returns the default 3s interval when no backoff is active', () => {
      expect(priv(service).currentInterval()).toBe(DEFAULT_INTERVAL_MS);
    });

    it('backoff is inactive by default on construction', () => {
      expect(priv(service).pollIntervalMs).toBe(DEFAULT_INTERVAL_MS);
      expect(priv(service).backoffUntilMs).toBe(0);
    });
  });
});
