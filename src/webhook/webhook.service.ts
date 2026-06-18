import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import { db } from '../db/index';
import { webhookDeliveries, merchants } from '../db/schema';
import { eq, and, lte } from 'drizzle-orm';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  async dispatchWebhook(merchantId: string, event: string, data: any) {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    });
    if (!merchant?.webhookUrl || !merchant?.webhookSecret) {
      this.logger.debug(`No webhook configured for merchant ${merchantId}`);
      return;
    }

    const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    const signature = crypto
      .createHmac('sha256', merchant.webhookSecret)
      .update(payload)
      .digest('hex');

    // Record delivery attempt
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        merchantId,
        event,
        payload: { event, data },
        attempts: 1,
      } as any)
      .returning();

    try {
      const response = await axios.post(merchant.webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-OrbitStream-Signature': signature,
          'X-OrbitStream-Timestamp': new Date().toISOString(),
        },
        timeout: 10000,
      });

      await db
        .update(webhookDeliveries)
        .set({
          responseStatus: response.status,
          deliveredAt: new Date(),
        } as any)
        .where(eq(webhookDeliveries.id, delivery.id));

      this.logger.log(`Webhook delivered: ${event} to ${merchant.webhookUrl}`);
    } catch (err: any) {
      const status = err.response?.status;
      const nextRetry = new Date(Date.now() + 60000); // retry in 1 min

      await db
        .update(webhookDeliveries)
        .set({
          responseStatus: status ?? null,
          nextRetryAt: nextRetry,
        } as any)
        .where(eq(webhookDeliveries.id, delivery.id));

      this.logger.error(`Webhook failed: ${event} — ${err.message}`);
    }
  }

  async retryFailedDeliveries() {
    const failed = await db.query.webhookDeliveries.findMany({
      where: and(
        eq(webhookDeliveries.deliveredAt, null as any),
        lte(webhookDeliveries.nextRetryAt, new Date()),
      ),
    });

    for (const delivery of failed) {
      if (delivery.attempts >= 5) continue;

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, delivery.merchantId),
      });
      if (!merchant?.webhookUrl || !merchant?.webhookSecret) continue;

      const payload = JSON.stringify({
        ...(delivery.payload as any),
        timestamp: new Date().toISOString(),
      });
      const signature = crypto
        .createHmac('sha256', merchant.webhookSecret)
        .update(payload)
        .digest('hex');

      try {
        const response = await axios.post(merchant.webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-OrbitStream-Signature': signature,
            'X-OrbitStream-Timestamp': new Date().toISOString(),
          },
          timeout: 10000,
        });

        await db
          .update(webhookDeliveries)
          .set({
            responseStatus: response.status,
            deliveredAt: new Date(),
            attempts: delivery.attempts + 1,
          } as any)
          .where(eq(webhookDeliveries.id, delivery.id));
      } catch {
        const backoff = Math.pow(2, delivery.attempts) * 60000;
        await db
          .update(webhookDeliveries)
          .set({
            attempts: delivery.attempts + 1,
            nextRetryAt: new Date(Date.now() + backoff),
          } as any)
          .where(eq(webhookDeliveries.id, delivery.id));
      }
    }
  }
}
