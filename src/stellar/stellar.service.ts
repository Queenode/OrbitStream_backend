import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

export interface PaymentsPage {
  records: any[];
  rateLimitLimit: number;
  rateLimitRemaining: number;
  httpStatus: number;
}

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  readonly horizonUrl = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

  async getAccountInfo(walletAddress: string) {
    const { data } = await axios.get(`${this.horizonUrl}/accounts/${walletAddress}`);
    return { id: data.id, sequence: data.sequence, balances: data.balances };
  }

  async getBalance(walletAddress: string, assetCode = 'native'): Promise<number> {
    const { data } = await axios.get(`${this.horizonUrl}/accounts/${walletAddress}`);
    const balance = data.balances?.find((b: any) =>
      assetCode === 'native' ? b.asset_type === 'native' : b.asset_code === assetCode,
    );
    return parseFloat(balance?.balance ?? '0');
  }

  async verifyTransaction(txHash: string): Promise<boolean> {
    try {
      const { data } = await axios.get(`${this.horizonUrl}/transactions/${txHash}`);
      return data.successful === true;
    } catch {
      return false;
    }
  }

  async getTransactionOperations(txHash: string) {
    const { data } = await axios.get(`${this.horizonUrl}/transactions/${txHash}/operations`);
    return data._embedded?.records ?? [];
  }

  async getPaymentsForAccount(accountAddress: string, cursor?: string) {
    const { records } = await this.getPaymentsPage(accountAddress, cursor);
    return records;
  }

  /**
   * Fetch a page of payments and return Horizon rate-limit metadata alongside the records.
   * Throws an AxiosError on non-2xx responses so callers can inspect the HTTP status.
   */
  async getPaymentsPage(accountAddress: string, cursor?: string): Promise<PaymentsPage> {
    const params: any = { order: 'asc', limit: 50 };
    if (cursor && cursor !== 'now') params.cursor = cursor;

    const response = await axios.get(`${this.horizonUrl}/accounts/${accountAddress}/payments`, {
      params,
    });

    return {
      records: response.data._embedded?.records ?? [],
      rateLimitLimit: parseInt(response.headers['x-ratelimit-limit'] ?? '200', 10),
      rateLimitRemaining: parseInt(response.headers['x-ratelimit-remaining'] ?? '200', 10),
      httpStatus: response.status,
    };
  }

  /** Extract HTTP status from an AxiosError, falling back to 0. */
  getHttpStatusFromError(err: unknown): number {
    if (axios.isAxiosError(err)) {
      return (err as AxiosError).response?.status ?? 0;
    }
    return 0;
  }

  async getAssetInfo(assetCode: string, assetIssuer?: string) {
    if (assetCode === 'XLM' || assetCode === 'native') {
      return { type: 'native', code: 'XLM' };
    }
    return {
      type: 'credit_alphanum4',
      code: assetCode,
      issuer: assetIssuer,
    };
  }
}
