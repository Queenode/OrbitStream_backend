import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';
import * as StellarSdk from '@stellar/stellar-sdk';
import axios from 'axios';

jest.mock('axios', () => {
  const mockAxios: any = jest.fn();
  mockAxios.get = jest.fn();
  mockAxios.post = jest.fn();
  mockAxios.create = jest.fn(() => mockAxios);
  mockAxios.interceptors = {
    request: { use: jest.fn(), eject: jest.fn() },
    response: { use: jest.fn(), eject: jest.fn() },
  };
  mockAxios.defaults = { headers: { common: {} } };
  return mockAxios;
});
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AuthService', () => {
  let service: AuthService;

  const mockWallet = StellarSdk.Keypair.random();
  const mockServerKeypair = StellarSdk.Keypair.random();
  const mockNonce = 'a'.repeat(64);

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  };

  beforeAll(() => {
    process.env.STELLAR_PLATFORM_SECRET_KEY = mockServerKeypair.secret();
    process.env.CHALLENGE_TTL_SECONDS = '300';
  });

  afterAll(() => {
    delete process.env.STELLAR_PLATFORM_SECRET_KEY;
    delete process.env.CHALLENGE_TTL_SECONDS;
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    mockRedisClient.incr.mockResolvedValue(1); // rate limit

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('mock-token') },
        },
        {
          provide: RedisService,
          useValue: { getClient: () => mockRedisClient },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    // Reset circuit breaker
    (service as any).horizonFailureCount = 0;
    (service as any).horizonCircuitOpenUntil = 0;
  });

  it('should request a challenge successfully', async () => {
    const result = await service.requestChallenge({ walletAddress: mockWallet.publicKey() });
    expect(result).toHaveProperty('transaction');
    expect(result).toHaveProperty('passphrase');
    expect(result).toHaveProperty('expiresAt');
    expect(mockRedisClient.set).toHaveBeenCalled();
  });

  it('should verify a valid challenge successfully', async () => {
    mockRedisClient.get.mockResolvedValue(mockNonce);
    mockedAxios.get.mockResolvedValue({
      data: { signers: [{ key: mockWallet.publicKey(), weight: 1 }] },
    });

    // Create a mock valid challenge tx
    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 100).toString(),
      maxTime: (Math.floor(Date.now() / 1000) + 100).toString(),
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
        timebounds,
      },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair); // Server signs
    tx.sign(mockWallet); // Client signs

    const result = await service.verifyChallenge({
      walletAddress: mockWallet.publicKey(),
      transaction: {
        tx: tx.toEnvelope().toXDR('base64'),
        passphrase: StellarSdk.Networks.TESTNET,
      },
    });

    expect(result.access_token).toBe('mock-token');
    expect(mockRedisClient.del).toHaveBeenCalled(); // single-use nonce
  });

  it('should reject if nonce is not in redis (expired/used)', async () => {
    mockRedisClient.get.mockResolvedValue(null);
    await expect(
      service.verifyChallenge({
        walletAddress: mockWallet.publicKey(),
        transaction: { tx: 'base64xdr', passphrase: StellarSdk.Networks.TESTNET },
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should reject expired timebounds (clock skew > 60s)', async () => {
    mockRedisClient.get.mockResolvedValue(mockNonce);

    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 400).toString(), // 400s in past
      maxTime: (Math.floor(Date.now() / 1000) - 100).toString(), // 100s in past
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
        timebounds,
      },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair);
    tx.sign(mockWallet);

    await expect(
      service.verifyChallenge({
        walletAddress: mockWallet.publicKey(),
        transaction: {
          tx: tx.toEnvelope().toXDR('base64'),
          passphrase: StellarSdk.Networks.TESTNET,
        },
      }),
    ).rejects.toThrow(/expired/i);
  });

  it('should retry horizon and then fail, opening circuit breaker', async () => {
    mockRedisClient.get.mockResolvedValue(mockNonce);

    // Simulate Horizon 503 error
    mockedAxios.get.mockRejectedValue({
      response: { status: 503 },
    });

    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 100).toString(),
      maxTime: (Math.floor(Date.now() / 1000) + 100).toString(),
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET, timebounds },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair);
    tx.sign(mockWallet);

    // Trigger the circuit breaker by failing 3 times
    for (let i = 0; i < 3; i++) {
      await expect(
        service.verifyChallenge({
          walletAddress: mockWallet.publicKey(),
          transaction: {
            tx: tx.toEnvelope().toXDR('base64'),
            passphrase: StellarSdk.Networks.TESTNET,
          },
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    }

    expect(mockedAxios.get).toHaveBeenCalledTimes(9); // 3 calls * (Initial + 2 retries)
    expect((service as any).horizonFailureCount).toBe(3);
    expect((service as any).horizonCircuitOpenUntil).toBeGreaterThan(Date.now());
  }, 30000);

  it('should enforce rate limiting', async () => {
    mockRedisClient.get.mockResolvedValue('11'); // Over limit
    await expect(
      service.verifyChallenge({
        walletAddress: mockWallet.publicKey(),
        transaction: { tx: 'base64xdr', passphrase: StellarSdk.Networks.TESTNET },
      }),
    ).rejects.toThrow(/Too many failed/i);
  });

  it('should reject wrong network passphrase', async () => {
    mockRedisClient.get.mockResolvedValue(mockNonce);

    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 100).toString(),
      maxTime: (Math.floor(Date.now() / 1000) + 100).toString(),
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.PUBLIC, timebounds }, // Wrong passphrase
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair);
    tx.sign(mockWallet);

    await expect(
      service.verifyChallenge({
        walletAddress: mockWallet.publicKey(),
        transaction: {
          tx: tx.toEnvelope().toXDR('base64'),
          passphrase: StellarSdk.Networks.TESTNET,
        },
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should reject forged signature', async () => {
    mockRedisClient.get.mockResolvedValue(mockNonce);

    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 100).toString(),
      maxTime: (Math.floor(Date.now() / 1000) + 100).toString(),
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET, timebounds },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair);
    // Missing client signature or using wrong keypair
    const fakeClient = StellarSdk.Keypair.random();
    tx.sign(fakeClient);

    mockedAxios.get.mockResolvedValue({
      data: { signers: [{ key: mockWallet.publicKey(), weight: 1 }] },
    });

    await expect(
      service.verifyChallenge({
        walletAddress: mockWallet.publicKey(),
        transaction: {
          tx: tx.toEnvelope().toXDR('base64'),
          passphrase: StellarSdk.Networks.TESTNET,
        },
      }),
    ).rejects.toThrow(/signature is invalid/i);
  });

  it('should handle Horizon timeout and trigger 503', async () => {
    // Reset circuit breaker to ensure a fresh start
    (service as any).horizonFailureCount = 0;
    (service as any).horizonCircuitOpenUntil = 0;

    mockRedisClient.get.mockResolvedValue(mockNonce);
    // Simulate Horizon timeout
    mockedAxios.get.mockRejectedValue({ code: 'ECONNABORTED' });

    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 100).toString(),
      maxTime: (Math.floor(Date.now() / 1000) + 100).toString(),
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET, timebounds },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair);
    tx.sign(mockWallet);

    // After 3 calls, circuit breaker opens
    for (let i = 0; i < 3; i++) {
      await expect(
        service.verifyChallenge({
          walletAddress: mockWallet.publicKey(),
          transaction: {
            tx: tx.toEnvelope().toXDR('base64'),
            passphrase: StellarSdk.Networks.TESTNET,
          },
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    }
  }, 30000);

  it('should reject clock skew edge cases (just outside)', async () => {
    mockRedisClient.get.mockResolvedValue(mockNonce);

    const timebounds = {
      minTime: (Math.floor(Date.now() / 1000) - 100).toString(),
      maxTime: (Math.floor(Date.now() / 1000) - 61).toString(), // 61s in past (skew limit is 60)
    };

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(mockServerKeypair.publicKey(), '0'),
      { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET, timebounds },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: mockWallet.publicKey(),
          name: `${mockServerKeypair.publicKey()} auth`,
          value: Buffer.from(mockNonce, 'hex'),
        }),
      )
      .build();

    tx.sign(mockServerKeypair);
    tx.sign(mockWallet);

    await expect(
      service.verifyChallenge({
        walletAddress: mockWallet.publicKey(),
        transaction: {
          tx: tx.toEnvelope().toXDR('base64'),
          passphrase: StellarSdk.Networks.TESTNET,
        },
      }),
    ).rejects.toThrow(/expired/i);
  });
});
