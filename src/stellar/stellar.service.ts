import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

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
    const params: any = { order: 'asc', limit: 50 };
    if (cursor && cursor !== 'now') {
      params.cursor = cursor;
    }
    try {
      const { data } = await axios.get(`${this.horizonUrl}/accounts/${accountAddress}/payments`, {
        params,
      });
      return data._embedded?.records ?? [];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to fetch payments', message);
      return [];
    }
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
