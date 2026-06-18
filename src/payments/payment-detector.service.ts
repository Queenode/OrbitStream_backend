import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { db } from '../db/index';
import { checkoutSessions, payments } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { StellarService } from '../stellar/stellar.service';
import { WebhookService } from '../webhook/webhook.service';
import { MetricsService } from '../monitoring/metrics.service';

@Injectable()
export class PaymentDetectorService implements OnModuleInit {
  private readonly logger = new Logger(PaymentDetectorService.name);
  private cursor: string = 'now';
  private polling = false;

  constructor(
    private readonly stellar: StellarService,
    private readonly webhooks: WebhookService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit() {
    const account = process.env.PLATFORM_RECEIVING_ACCOUNT;
    if (!account) {
      this.logger.warn('PLATFORM_RECEIVING_ACCOUNT not set — payment detection disabled');
      return;
    }
    this.logger.log(`Starting payment detection for account ${account}`);
    this.startPolling(account);
  }

  private async startPolling(account: string) {
    this.polling = true;
    while (this.polling) {
      try {
        const payments = await this.stellar.getPaymentsForAccount(account, this.cursor);
        for (const op of payments) {
          await this.processPayment(op);
          if (op.paging_token) {
            this.cursor = op.paging_token;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('Payment polling error', message);
      }
      await this.sleep(3000);
    }
  }

  private async processPayment(op: any) {
    if (op.type !== 'payment') return;

    const memo = op.transaction_memo;
    if (!memo) return;

    // Find pending session with this memo
    const session = await db.query.checkoutSessions.findFirst({
      where: and(eq(checkoutSessions.memo, memo), eq(checkoutSessions.status, 'pending')),
    });
    if (!session) return;

    // Verify amount matches
    const opAmount = parseFloat(op.amount);
    const sessionAmount = parseFloat(session.amount);
    if (Math.abs(opAmount - sessionAmount) > 0.0000001) {
      this.logger.warn(
        `Amount mismatch for memo ${memo}: expected ${sessionAmount}, got ${opAmount}`,
      );
      return;
    }

    // Verify asset matches
    if (op.asset_code !== session.assetCode && session.assetCode !== 'XLM') {
      this.logger.warn(
        `Asset mismatch for memo ${memo}: expected ${session.assetCode}, got ${op.asset_code}`,
      );
      return;
    }

    // Mark session as paid
    await db
      .update(checkoutSessions)
      .set({ status: 'paid' } as any)
      .where(eq(checkoutSessions.id, session.id));

    // Record payment
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

    // Dispatch webhook
    await this.webhooks.dispatchWebhook(session.merchantId, 'payment.confirmed', {
      sessionId: session.id,
      txHash: op.transaction_hash,
      amount: op.amount,
      asset: op.asset_code ?? 'XLM',
      sender: op.from,
    });
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
