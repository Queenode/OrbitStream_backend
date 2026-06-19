import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { WebhookService } from './webhook.service';
import { MerchantsService } from '../merchants/merchants.service';

@Controller('v1/webhooks')
@UseGuards(AuthGuard('jwt'))
export class WebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly merchants: MerchantsService,
  ) {}

  private async merchantId(req: any): Promise<string> {
    const merchant = await this.merchants.findByWallet(req.user.walletAddress);
    if (!merchant) throw new NotFoundException('Merchant not found');
    return merchant.id;
  }

  /** List recent webhook deliveries for the authenticated merchant. */
  @Get('deliveries')
  async listDeliveries(@Request() req: any, @Query('limit') limit?: string) {
    const merchantId = await this.merchantId(req);
    return this.webhooks.listDeliveries(merchantId, this.clampLimit(limit));
  }

  /** Bound a client-supplied limit to a sane [1, 100] range (default 50). */
  private clampLimit(limit?: string): number {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(Math.floor(n), 100);
  }

  /** List dead-letter entries for the authenticated merchant. */
  @Get('dead-letter')
  async listDeadLetter(@Request() req: any) {
    const merchantId = await this.merchantId(req);
    return this.webhooks.listDeadLetters(merchantId);
  }

  /** Manually retry a dead-letter entry. */
  @Post('dead-letter/:id/retry')
  async retryDeadLetter(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const merchantId = await this.merchantId(req);
    const result = await this.webhooks.retryDeadLetter(merchantId, id);
    if (!result) throw new NotFoundException('Dead-letter entry not found');
    return { status: 'requeued', ...result };
  }

  /** Dismiss (delete) a dead-letter entry. */
  @Delete('dead-letter/:id')
  async dismissDeadLetter(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const merchantId = await this.merchantId(req);
    const ok = await this.webhooks.dismissDeadLetter(merchantId, id);
    if (!ok) throw new NotFoundException('Dead-letter entry not found');
    return { status: 'dismissed' };
  }
}
