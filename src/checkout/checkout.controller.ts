import { Controller, Post, Get, Body, Param, UseGuards, Request } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { CreateSessionDto } from './checkout.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';

@Controller('v1/checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @UseGuards(ApiKeyGuard)
  @Post('sessions')
  createSession(@Request() req: any, @Body() dto: CreateSessionDto) {
    return this.checkout.createSession(req.merchantId, dto);
  }

  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    return this.checkout.getSession(id);
  }

  @UseGuards(ApiKeyGuard)
  @Post('sessions/:id/cancel')
  cancelSession(@Request() req: any, @Param('id') id: string) {
    return this.checkout.cancelSession(id, req.merchantId);
  }
}
