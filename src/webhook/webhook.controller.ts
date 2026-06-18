import { Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  // Manual retry trigger for failed deliveries (merchant dashboard)
  @UseGuards(AuthGuard('jwt'))
  @Post('retry')
  async retryFailed() {
    await this.webhooks.retryFailedDeliveries();
    return { status: 'ok' };
  }
}
