import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookQueueService } from './webhook-queue.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { MerchantsModule } from '../merchants/merchants.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  // RedisModule is @Global() (provides RedisService) but is imported explicitly
  // here to make the queue's Redis dependency self-documenting.
  imports: [MerchantsModule, RedisModule],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookQueueService, WebhookDeliveryService],
  exports: [WebhookService, WebhookQueueService],
})
export class WebhookModule {}
