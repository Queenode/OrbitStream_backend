import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  classifyStatus,
  DELIVERY_TIMEOUT_MS,
  DeliveryOutcome,
  signPayload,
} from './webhook.constants';

export interface DeliveryTarget {
  url: string;
  secret: string;
}

export interface DeliveryRequest {
  deliveryId: string;
  timestamp: string;
  event: string;
  sequence: number;
  payload: string; // serialized JSON body
}

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  status: number | null;
  error: string | null;
}

/**
 * Performs a single HTTP webhook delivery attempt and classifies the result.
 * No queue / retry concerns live here — that is the queue service's job.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  async deliver(target: DeliveryTarget, req: DeliveryRequest): Promise<DeliveryResult> {
    const signature = signPayload(target.secret, req.deliveryId, req.timestamp, req.payload);

    try {
      const response = await axios.post(target.url, req.payload, {
        timeout: DELIVERY_TIMEOUT_MS,
        // We classify non-2xx ourselves instead of letting axios throw.
        validateStatus: () => true,
        headers: {
          'Content-Type': 'application/json',
          'X-OrbitStream-Event': req.event,
          'X-OrbitStream-Delivery-Id': req.deliveryId,
          'X-OrbitStream-Timestamp': req.timestamp,
          'X-OrbitStream-Sequence': String(req.sequence),
          'X-OrbitStream-Signature': `sha256=${signature}`,
        },
      });

      const outcome = classifyStatus(response.status);
      if (outcome !== 'success') {
        this.logger.warn(
          `Webhook ${req.event} (${req.deliveryId}) → HTTP ${response.status} [${outcome}]`,
        );
      }
      return {
        outcome,
        status: response.status,
        error: outcome === 'success' ? null : `HTTP ${response.status}`,
      };
    } catch (err: any) {
      // Network error / timeout / DNS — always retryable.
      const message = err?.code ? `${err.code}: ${err.message}` : (err?.message ?? 'network error');
      this.logger.warn(`Webhook ${req.event} (${req.deliveryId}) network error — ${message}`);
      return { outcome: 'retry', status: null, error: message };
    }
  }
}
