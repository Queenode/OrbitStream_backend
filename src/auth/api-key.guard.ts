import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { MerchantsService } from '../merchants/merchants.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing API key');
    }

    const rawKey = authHeader.slice(7);
    const merchantId = await this.merchants.validateApiKey(rawKey);

    if (!merchantId) {
      throw new UnauthorizedException('Invalid API key');
    }

    request.merchantId = merchantId;
    return true;
  }
}
