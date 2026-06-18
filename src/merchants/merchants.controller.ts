import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MerchantsService } from './merchants.service';
import {
  RegisterMerchantDto,
  UpdateMerchantDto,
  SetWebhookDto,
  GenerateApiKeyDto,
} from './merchants.dto';

@Controller('merchants')
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Post('register')
  register(@Body() dto: RegisterMerchantDto) {
    return this.merchants.register(dto.walletAddress, dto.businessName, dto.email);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  getProfile(@Request() req: any) {
    return this.merchants.findByWallet(req.user.walletAddress);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('me')
  updateProfile(@Request() req: any, @Body() dto: UpdateMerchantDto) {
    return this.merchants.findByWallet(req.user.walletAddress).then((m) => {
      if (!m) throw new Error('Merchant not found');
      return this.merchants.update(m.id, dto);
    });
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('me/api-keys')
  generateApiKey(@Request() req: any, @Body() dto: GenerateApiKeyDto) {
    return this.merchants.findByWallet(req.user.walletAddress).then((m) => {
      if (!m) throw new Error('Merchant not found');
      return this.merchants.generateApiKey(m.id, dto.environment);
    });
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('me/api-keys')
  listApiKeys(@Request() req: any) {
    return this.merchants.findByWallet(req.user.walletAddress).then((m) => {
      if (!m) throw new Error('Merchant not found');
      return this.merchants.listApiKeys(m.id);
    });
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete('me/api-keys/:id')
  revokeApiKey(@Request() req: any, @Param('id') keyId: string) {
    return this.merchants.findByWallet(req.user.walletAddress).then((m) => {
      if (!m) throw new Error('Merchant not found');
      return this.merchants.revokeApiKey(m.id, keyId);
    });
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('me/webhook')
  setWebhook(@Request() req: any, @Body() dto: SetWebhookDto) {
    return this.merchants.findByWallet(req.user.walletAddress).then((m) => {
      if (!m) throw new Error('Merchant not found');
      return this.merchants.setWebhook(m.id, dto.webhookUrl);
    });
  }
}
