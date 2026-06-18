import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { db } from '../db/index';
import { checkoutSessions, payments } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { StellarService } from '../stellar/stellar.service';
import { WebhookService } from '../webhook/webhook.service';
import { MetricsService } from '../monitoring/metrics.service';
import { PaymentCursorService, PERSIST_EVERY } from './payment-cursor.service';

const DEFAULT_INTERVAL_MS = 3_000;
const BACKOFF_429_MS = 10_000;
const BACKOFF_5XX_MS = 5_000;
const BACKOFF_429_DURATION = 60_000;
const BACKOFF_5XX_DURATION = 30_000;
const RATE_LIMIT_WARN_AT = 10;

@Injectable()
export class PaymentDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentDetectorService.name);
  private readonly instanceId = randomUUID();

  private cursor: string = 'now';
  private polling = false;
  private opsSinceFlush = 0;
  private pollIntervalMs = DEFAULT_INTERVAL_MS;
  private backoffUntilMs = 0;

  constructor(
    private readonly stellar: StellarService,
    private readonly webhooks: WebhookService,
    private readonly metrics: MetricsService,
    private readonly cursorService: PaymentCursorService,
  ) {}

  async onModuleInit(): Promise<void> {
    const account = process.env.PLATFORM_RECEIVING_ACCOUNT;
    if (!account) {
      this.logger.warn('PLATFORM_RECEIVING_ACCOUNT not set — payment detection disabled');
      return;
    }
    this.cursor = await this.cursorService.restoreCursor(account);
    this.logger.log(`Starting payment detection for ${account} (instance ${this.instanceId})`);
    this.startPolling(account);
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    const account = process.env.PLATFORM_RECEIVING_ACCOUNT;
    if (account) await this.cursorService.releaseLock(account, this.instanceId);
  }

  private async startPolling(account: string): Promise<void> {
    this.polling = true;

    while (this.polling) {
      // ── Leader election ────────────────────────────────────────────────────
      const hasLock =
        (await this.cursorService.renewLock(account, this.instanceId)) ||
        (await this.cursorService.acquireLock(account, this.instanceId));

      if (!hasLock) {
        this.logger.debug(`Skipping poll — lock held by another instance`);
        await this.sleep(this.currentInterval());
        continue;
      }

      // ── Fetch & process ────────────────────────────────────────────────────
      try {
        const page = await this.stellar.getPaymentsPage(account, this.cursor);

        if (page.rateLimitRemaining < RATE_LIMIT_WARN_AT) {
          this.logger.warn(
            `Horizon rate limit low (${page.rateLimitRemaining} remaining) — backing off`,
          );
          this.pollIntervalMs = BACKOFF_429_MS;
          this.backoffUntilMs = Date.now() + BACKOFF_429_DURATION;
        }

        for (const op of page.records) {
          await this.processPayment(op);

          if (op.paging_token) {
            const prev = this.cursor;
            this.cursor = op.paging_token;
            this.opsSinceFlush++;

            await this.cursorService.appendCheckpoint(account, op.paging_token);

            if (this.opsSinceFlush >= PERSIST_EVERY) {
              const updated = await this.cursorService.updateCursor(account, prev, this.cursor);
              if (!updated) {
                this.logger.warn('Cursor CAS failed — another instance may have advanced ahead');
              }
              this.opsSinceFlush = 0;
            }
          }
        }

        if (Date.now() > this.backoffUntilMs) {
          this.pollIntervalMs = DEFAULT_INTERVAL_MS;
        }
      } catch (err: unknown) {
        const status = this.stellar.getHttpStatusFromError(err);
        const message = err instanceof Error ? err.message : String(err);

        if (status === 429) {
          this.pollIntervalMs = BACKOFF_429_MS;
          this.backoffUntilMs = Date.now() + BACKOFF_429_DURATION;
          this.logger.warn('Horizon rate-limited (429) — backing off to 10s for 1 minute');
        } else if (status >= 500) {
          this.pollIntervalMs = BACKOFF_5XX_MS;
          this.backoffUntilMs = Date.now() + BACKOFF_5XX_DURATION;
          this.logger.warn(`Horizon ${status} error — backing off to 5s for 30 seconds`);
        } else {
          this.logger.error('Payment polling error', message);
        }
      }

      await this.sleep(this.currentInterval());
    }
  }

  private currentInterval(): number {
    if (Date.now() < this.backoffUntilMs) return this.pollIntervalMs;
    this.pollIntervalMs = DEFAULT_INTERVAL_MS;
    return DEFAULT_INTERVAL_MS;
  }

  private async processPayment(op: any): Promise<void> {
    if (op.type !== 'payment') return;

    const memo = op.transaction_memo;
    if (!memo) return;

    const session = await db.query.checkoutSessions.findFirst({
      where: and(eq(checkoutSessions.memo, memo), eq(checkoutSessions.status, 'pending')),
    });
    if (!session) return;

    const opAmount = parseFloat(op.amount);
    const sessionAmount = parseFloat(session.amount);
    if (Math.abs(opAmount - sessionAmount) > 0.0000001) {
      this.logger.warn(
        `Amount mismatch for memo ${memo}: expected ${sessionAmount}, got ${opAmount}`,
      );
      return;
    }

    if (op.asset_code !== session.assetCode && session.assetCode !== 'XLM') {
      this.logger.warn(
        `Asset mismatch for memo ${memo}: expected ${session.assetCode}, got ${op.asset_code}`,
      );
      return;
    }

    await db
      .update(checkoutSessions)
      .set({ status: 'paid' } as any)
      .where(eq(checkoutSessions.id, session.id));

    await db.insert(payments).values({
      sessionId: session.id,
      merchantId: session.merchantId,
      txHash: op.transaction_hash,
      amount: op.amount,
      assetCode: op.asset_code ?? 'XLM',
      assetIssuer: op.asset_issuer ?? null,
      senderAddress: op.from,
      confirmedAt: new Date(),
    } as any);

    this.metrics.paymentsConfirmed.inc();
    this.logger.log(`Payment confirmed for session ${session.id} — tx ${op.transaction_hash}`);

    await this.webhooks.dispatchWebhook(session.merchantId, 'payment.confirmed', {
      sessionId: session.id,
      txHash: op.transaction_hash,
      amount: op.amount,
      asset: op.asset_code ?? 'XLM',
      sender: op.from,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
