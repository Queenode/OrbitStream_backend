import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RequestChallengeDto, VerifyChallengeDto } from './auth.dto';
import * as StellarSdk from '@stellar/stellar-sdk';
import * as crypto from 'crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_BYTES = 48; // 96-char hex nonce
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
    const now = Math.floor(Date.now() / 1000);

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

      const txEnvelope = transaction.toEnvelopeXDR('base64');

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
    } catch (err) {
      this.logger.error(`Failed to create SEP-10 challenge: ${err.message}`);
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
      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        txData.tx,
        txData.passphrase,
      );

      if (transaction.source != walletAddress) {
        throw new UnauthorizedException('Transaction source does not match wallet address');
      }

      const networkPassphrase = this.getNetworkPassphrase();
      const serverKeypair = this.getServerKeypair();

      const signatureHint = transaction.signatures[0].hint();
      const serverHint = serverKeypair.signatureHint();

      if (Buffer.compare(signatureHint, serverHint) !== 0) {
        throw new UnauthorizedException('Transaction not signed by server account');
      }

      const valid = transaction.verifySignatures();
      if (!valid) {
        throw new UnauthorizedException('Transaction signature verification failed');
      }

      const operations = transaction.operations;
      if (operations.length !== 1) {
        throw new UnauthorizedException('Challenge transaction must have exactly one operation');
      }

      const op = operations[0] as StellarSdk.ManageDataOperation;
      if (op.name !== `${pending.serverAccountId} auth`) {
        throw new UnauthorizedException('Invalid manageData operation name');
      }

      const opNonce = Buffer.from(op.value as Buffer).toString('hex');
      if (opNonce !== pending.nonce) {
        throw new UnauthorizedException('Nonce mismatch');
      }

      this.pendingChallenges.delete(walletAddress);

      const payload = { sub: walletAddress, walletAddress, authMethod: 'sep10' };
      return {
        access_token: this.jwt.sign(payload),
        wallet: walletAddress,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException || err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`SEP-10 verification failed: ${err.message}`);
      throw new UnauthorizedException('Transaction verification failed');
    }
  }

  async walletLogin(dto: { walletAddress: string }) {
    const { walletAddress } = dto;
    const payload = { sub: walletAddress, walletAddress, authMethod: 'wallet' };
    return { access_token: this.jwt.sign(payload), wallet: walletAddress };
  }
}
