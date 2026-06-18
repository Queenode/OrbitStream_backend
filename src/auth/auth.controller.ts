import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { WalletLoginDto, RequestChallengeDto, VerifyChallengeDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  requestChallenge(@Body() dto: RequestChallengeDto) {
    return this.auth.requestChallenge(dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verifyChallenge(@Body() dto: VerifyChallengeDto) {
    return this.auth.verifyChallenge(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: WalletLoginDto) {
    return this.auth.walletLogin(dto);
  }
}
