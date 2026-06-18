import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('mock-token') },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get<JwtService>(JwtService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return token for valid wallet address via walletLogin', async () => {
    const result = await service.walletLogin({
      walletAddress: 'G' + 'A'.repeat(55),
    });
    expect(result).toHaveProperty('access_token');
    expect(result).toHaveProperty('wallet');
    expect(result.access_token).toBe('mock-token');
    expect(jest.spyOn(jwtService, 'sign')).toHaveBeenCalled();
  });

  it('should throw BadRequestException when requestChallenge has no server configured', async () => {
    await expect(service.requestChallenge({ walletAddress: 'G' + 'A'.repeat(55) })).rejects.toThrow(
      BadRequestException,
    );
  });
});
