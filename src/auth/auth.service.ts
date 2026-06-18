import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RequestChallengeDto, VerifyChallengeDto } from './auth.dto';
import * as StellarSdk from '@stellar/stellar-sdk';
import * as crypto from 'crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const NONCE_BYTES = 48;
const SERVER_ACCOUNT =
  process.env.STELLAR_PLATFORM_ACCOUNT || process.env.PLATFORM_RECEIVING_ACCOUNT;

interface PendingChallenge {
  nonce: string;
  serverAccountId: string;
  createdAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly pendingChallenges = new Map<string, PendingChallenge>();
  private serverKeypair: StellarSdk.Keypair | null = null;

  constructor(private readonly jwt: JwtService) {
    this.initializeServerKeypair();
  }

  private initializeServerKeypair() {
    const secret = process.env.STELLAR_PLATFORM_SECRET_KEY;
    if (secret) {
      try {
        this.serverKeypair = StellarSdk.Keypair.fromSecret(secret);
        this.logger.log('SEP-10 server keypair initialized from STELLAR_PLATFORM_SECRET_KEY');
      } catch {
        this.logger.error('Invalid STELLAR_PLATFORM_SECRET_KEY — SEP-10 challenges will fail');
      }
    }
  }

  private getServerAccountId(): string {
    if (this.serverKeypair) {
      return this.serverKeypair.publicKey();
    }
    if (SERVER_ACCOUNT) {
      return SERVER_ACCOUNT;
    }
    throw new BadRequestException(
      'SEP-10 not configured: set STELLAR_PLATFORM_SECRET_KEY or PLATFORM_RECEIVING_ACCOUNT',
    );
  }

  private getServerKeypair(): StellarSdk.Keypair {
    if (!this.serverKeypair) {
      throw new BadRequestException(
        'SEP-10 not configured: set STELLAR_PLATFORM_SECRET_KEY environment variable',
      );
    }
    return this.serverKeypair;
  }

  private getNetworkPassphrase(): string {
    const network = process.env.STELLAR_NETWORK?.toUpperCase();
    if (network === 'MAINNET') {
      return StellarSdk.Networks.PUBLIC;
    }
    return StellarSdk.Networks.TESTNET;
  }

  private cleanExpiredChallenges() {
    const now = Date.now();
    for (const [key, challenge] of this.pendingChallenges) {
      if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
        this.pendingChallenges.delete(key);
      }
    }
  }

  async requestChallenge(dto: RequestChallengeDto) {
    const { walletAddress } = dto;
    this.cleanExpiredChallenges();

    const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
    const serverAccountId = this.getServerAccountId();

    try {
      const serverAccount = await new StellarSdk.Horizon.Server(
        process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
      ).loadAccount(serverAccountId);

      const transaction = new StellarSdk.TransactionBuilder(serverAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            source: walletAddress,
            name: `${serverAccountId} auth`,
            value: Buffer.from(nonce, 'hex'),
          }),
        )
        .setTimeout(CHALLENGE_TTL_MS / 1000)
        .build();

      const txEnvelope = transaction.toEnvelope().toXDR('base64');

      this.pendingChallenges.set(walletAddress, {
        nonce,
        serverAccountId,
        createdAt: Date.now(),
      });

      return {
        transaction: txEnvelope,
        passphrase: this.getNetworkPassphrase(),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to create SEP-10 challenge: ${message}`);
      throw new BadRequestException('Failed to create authentication challenge');
    }
  }

  async verifyChallenge(dto: VerifyChallengeDto) {
    const { walletAddress, transaction: txData } = dto;
    const pending = this.pendingChallenges.get(walletAddress);

    if (!pending) {
      throw new UnauthorizedException('No pending challenge for this wallet. Request a new one.');
    }

    if (Date.now() - pending.createdAt > CHALLENGE_TTL_MS) {
      this.pendingChallenges.delete(walletAddress);
      throw new UnauthorizedException('Challenge expired. Request a new one.');
    }

    try {
      const transaction = StellarSdk.TransactionBuilder.fromXDR(txData.tx, txData.passphrase);

      const txSource = (transaction as StellarSdk.Transaction).source;
      if (txSource !== walletAddress) {
        throw new UnauthorizedException('Transaction source does not match wallet address');
      }

      const serverKeypair = this.getServerKeypair();

      const signatureHint = transaction.signatures[0].hint();
      const serverHint = serverKeypair.signatureHint();

      if (Buffer.compare(signatureHint, serverHint) !== 0) {
        throw new UnauthorizedException('Transaction not signed by server account');
      }

      const operations = transaction.operations;
      if (operations.length !== 1) {
        throw new UnauthorizedException('Challenge transaction must have exactly one operation');
      }

      const op = operations[0] as unknown as StellarSdk.Operation.ManageData;
      const opName = (op as unknown as { name: string }).name;
      if (opName !== `${pending.serverAccountId} auth`) {
        throw new UnauthorizedException('Invalid manageData operation name');
      }

      const opValue = (op as unknown as { value: Buffer }).value;
      const opNonce = Buffer.from(opValue).toString('hex');
      if (opNonce !== pending.nonce) {
        throw new UnauthorizedException('Nonce mismatch');
      }

      this.pendingChallenges.delete(walletAddress);

      const payload = { sub: walletAddress, walletAddress, authMethod: 'sep10' };
      return {
        access_token: this.jwt.sign(payload),
        wallet: walletAddress,
      };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException || err instanceof BadRequestException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`SEP-10 verification failed: ${message}`);
      throw new UnauthorizedException('Transaction verification failed');
    }
  }

  async walletLogin(dto: { walletAddress: string }) {
    const { walletAddress } = dto;
    const payload = { sub: walletAddress, walletAddress, authMethod: 'wallet' };
    return { access_token: this.jwt.sign(payload), wallet: walletAddress };
  }
}
