import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookQueueService } from './webhook-queue.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { MerchantsModule } from '../merchants/merchants.module';

@Module({
  imports: [MerchantsModule],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookQueueService, WebhookDeliveryService],
  exports: [WebhookService, WebhookQueueService],
})
export class WebhookModule {}
