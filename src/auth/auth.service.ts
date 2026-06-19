import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RequestChallengeDto, VerifyChallengeDto } from './auth.dto';
import { RedisService } from '../redis/redis.service';
import * as StellarSdk from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import axios from 'axios';

const CHALLENGE_TTL_SECONDS = parseInt(process.env.CHALLENGE_TTL_SECONDS || '300', 10);
const NONCE_BYTES = 32;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Circuit breaker state
  private horizonFailureCount = 0;
  private horizonCircuitOpenUntil = 0;

  constructor(
    private readonly jwt: JwtService,
    private readonly redisService: RedisService,
  ) {}

  private getNetworkConfig() {
    const network = (process.env.STELLAR_NETWORK || 'TESTNET').toUpperCase();
    if (network === 'MAINNET') {
      return {
        passphrase: StellarSdk.Networks.PUBLIC,
        horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org',
        secret: process.env.MAINNET_AUTH_SECRET_KEY || process.env.STELLAR_PLATFORM_SECRET_KEY,
      };
    }
    return {
      passphrase: StellarSdk.Networks.TESTNET,
      horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
      secret: process.env.TESTNET_AUTH_SECRET_KEY || process.env.STELLAR_PLATFORM_SECRET_KEY,
    };
  }

  private cachedServerKeypair: StellarSdk.Keypair | null = null;

  private getServerKeypair(): StellarSdk.Keypair {
    if (this.cachedServerKeypair) {
      return this.cachedServerKeypair;
    }
    const config = this.getNetworkConfig();
    if (!config.secret) {
      throw new BadRequestException('Auth server secret key not configured for the active network');
    }
    this.cachedServerKeypair = StellarSdk.Keypair.fromSecret(config.secret);
    return this.cachedServerKeypair;
  }

  private async fetchAccountSignersWithResilience(accountId: string, horizonUrl: string) {
    if (Date.now() < this.horizonCircuitOpenUntil) {
      throw new ServiceUnavailableException('Horizon API temporarily unavailable');
    }

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(`${horizonUrl}/accounts/${accountId}`, {
          timeout: 5000,
        });
        this.horizonFailureCount = 0; // reset on success
        return response.data.signers || [];
      } catch (error: any) {
        if (error.response?.status === 404) {
          // Account not found on ledger, not an API failure. Master key is the only signer.
          return [{ key: accountId, weight: 1 }];
        }

        const isServerError = error.response?.status >= 500;
        const isTimeout =
          error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'));

        if (isServerError || isTimeout) {
          if (attempt < maxRetries) {
            const delay = attempt === 0 ? 1000 : 2000;
            await new Promise((res) => setTimeout(res, delay));
            continue;
          } else {
            this.horizonFailureCount++;
            if (this.horizonFailureCount >= 3) {
              this.horizonCircuitOpenUntil = Date.now() + 30000; // 30 seconds
              this.logger.error('Horizon circuit breaker opened for 30s');
            }
            throw new ServiceUnavailableException('Horizon API is unreachable');
          }
        }

        throw error;
      }
    }
  }

  private verifyTxSignedBy(transaction: StellarSdk.Transaction, publicKey: string): boolean {
    try {
      const hash = transaction.hash();
      const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
      const expectedHint = keypair.signatureHint();
      return transaction.signatures.some((sig) => {
        if (sig.hint().equals(expectedHint)) {
          return keypair.verify(hash, sig.signature());
        }
        return false;
      });
    } catch {
      return false;
    }
  }

  async requestChallenge(dto: RequestChallengeDto) {
    const { walletAddress } = dto;
    const config = this.getNetworkConfig();
    const serverKeypair = this.getServerKeypair();
    const serverAccountId = serverKeypair.publicKey();

    const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');

    // We mock the sequence number for the challenge transaction. Standard SEP-10 uses "0".
    const serverAccount = new StellarSdk.Account(serverAccountId, '0');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const timebounds = {
      minTime: (nowSeconds - CHALLENGE_TTL_SECONDS).toString(),
      maxTime: (nowSeconds + CHALLENGE_TTL_SECONDS).toString(),
    };

    const transaction = new StellarSdk.TransactionBuilder(serverAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: config.passphrase,
      timebounds,
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          source: walletAddress,
          name: `${serverAccountId} auth`,
          value: Buffer.from(nonce, 'hex'),
        }),
      )
      .build();

    transaction.sign(serverKeypair);

    const txEnvelope = transaction.toEnvelope().toXDR('base64');

    const redis = this.redisService.getClient();
    await redis.set(`challenge:${walletAddress}`, nonce, 'EX', CHALLENGE_TTL_SECONDS);

    return {
      transaction: txEnvelope,
      passphrase: config.passphrase,
      expiresAt: new Date((nowSeconds + CHALLENGE_TTL_SECONDS) * 1000).toISOString(),
    };
  }

  async verifyChallenge(dto: VerifyChallengeDto) {
    const { walletAddress } = dto;
    const redis = this.redisService.getClient();
    const rateLimitKey = `rate_limit:verify:${walletAddress}`;

    const attemptsStr = await redis.get(rateLimitKey);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;
    if (attempts >= 10) {
      throw new UnauthorizedException('Too many failed verification attempts. Try again later.');
    }

    try {
      return await this.verifyChallengeCore(dto, redis);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        const newAttempts = await redis.incr(rateLimitKey);
        if (newAttempts === 1) {
          await redis.expire(rateLimitKey, 60);
        }
      }
      throw error;
    }
  }

  private async verifyChallengeCore(dto: VerifyChallengeDto, redis: any) {
    const { walletAddress, transaction: txData } = dto;
    const storedNonce = await redis.get(`challenge:${walletAddress}`);

    if (!storedNonce) {
      throw new UnauthorizedException('Challenge expired or not found. Request a new one.');
    }

    let transaction: StellarSdk.Transaction;
    try {
      transaction = StellarSdk.TransactionBuilder.fromXDR(
        txData.tx,
        txData.passphrase,
      ) as StellarSdk.Transaction;
    } catch {
      throw new UnauthorizedException('Invalid transaction XDR');
    }

    const config = this.getNetworkConfig();
    const serverKeypair = this.getServerKeypair();

    const txSource = transaction.source;
    if (txSource !== serverKeypair.publicKey()) {
      throw new UnauthorizedException('Transaction source does not match server account');
    }

    // Check operations
    const operations = transaction.operations;
    if (operations.length !== 1) {
      throw new UnauthorizedException('Challenge transaction must have exactly one operation');
    }

    const op = operations[0] as unknown as StellarSdk.Operation.ManageData;
    if (op.source !== walletAddress) {
      throw new UnauthorizedException('Operation source does not match wallet address');
    }

    const opName = op.name;
    if (opName !== `${serverKeypair.publicKey()} auth`) {
      throw new UnauthorizedException('Invalid manageData operation name');
    }

    const opValue = op.value;
    const opNonce = Buffer.from(opValue).toString('hex');
    if (opNonce !== storedNonce) {
      throw new UnauthorizedException('Nonce mismatch');
    }

    // Validate Timebounds
    const timebounds = transaction.timeBounds;
    if (!timebounds) {
      throw new UnauthorizedException('Transaction must have timebounds');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const minTime = parseInt(timebounds.minTime, 10);
    const maxTime = parseInt(timebounds.maxTime, 10);

    // Clock skew tolerance
    const skewLimit = 60;
    if (nowSeconds < minTime - skewLimit || nowSeconds > maxTime + skewLimit) {
      throw new UnauthorizedException('Challenge transaction expired (timebounds)');
    }

    const minSkew = Math.max(0, minTime - nowSeconds);
    const maxSkew = Math.max(0, nowSeconds - maxTime);
    const actualSkew = Math.max(minSkew, maxSkew);

    if (actualSkew > 30) {
      this.logger.warn(`Significant clock skew detected: ${actualSkew} seconds`);
    }

    // Server should have signed the challenge initially
    const serverSigned = this.verifyTxSignedBy(transaction, serverKeypair.publicKey());
    if (!serverSigned) {
      throw new UnauthorizedException('Transaction not signed by server account');
    }

    // Check client signatures
    let signers: Array<{ key: string; weight: number }> = [];
    try {
      signers = await this.fetchAccountSignersWithResilience(walletAddress, config.horizonUrl);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(`Failed to fetch account for verification: ${error}`);
      throw new UnauthorizedException('Verification failed during network request');
    }

    // Check if the client signed it directly
    const clientSigned = this.verifyTxSignedBy(transaction, walletAddress);

    // To support multi-sig, we check if ANY of the signers' public keys have signed the tx
    const hasValidSigner = signers.some((signer) => this.verifyTxSignedBy(transaction, signer.key));

    if (!clientSigned && !hasValidSigner) {
      throw new UnauthorizedException('Transaction signature is invalid or insufficient');
    }

    // Success! Delete nonce
    await redis.del(`challenge:${walletAddress}`);

    const payload = { sub: walletAddress, walletAddress, authMethod: 'sep10' };
    return {
      access_token: this.jwt.sign(payload),
      wallet: walletAddress,
    };
  }

  async walletLogin(dto: { walletAddress: string }) {
    const { walletAddress } = dto;
    const payload = { sub: walletAddress, walletAddress, authMethod: 'wallet' };
    return { access_token: this.jwt.sign(payload), wallet: walletAddress };
  }
}
