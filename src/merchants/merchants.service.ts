import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { db } from '../db/index';
import { merchants, apiKeys } from '../db/schema';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';

@Injectable()
export class MerchantsService {
  async register(walletAddress: string, businessName: string, email: string) {
    const existing = await db.query.merchants.findFirst({
      where: eq(merchants.walletAddress, walletAddress),
    });
    if (existing) throw new ConflictException('Merchant already registered');

    const [merchant] = await db
      .insert(merchants)
      .values({ walletAddress, businessName, email })
      .returning();
    return merchant;
  }

  async findByWallet(walletAddress: string) {
    return db.query.merchants.findFirst({
      where: eq(merchants.walletAddress, walletAddress),
    });
  }

  async findById(id: string) {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, id),
    });
    if (!merchant) throw new NotFoundException('Merchant not found');
    return merchant;
  }

  async update(id: string, data: { businessName?: string; email?: string; logoUrl?: string }) {
    const [updated] = await db.update(merchants).set(data).where(eq(merchants.id, id)).returning();
    return updated;
  }

  async generateApiKey(merchantId: string, environment: 'testnet' | 'mainnet') {
    const prefix = environment === 'testnet' ? 'sk_test_' : 'sk_live_';
    const rawKey = prefix + crypto.randomBytes(24).toString('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    await db.insert(apiKeys).values({
      merchantId,
      keyPrefix,
      keyHash,
      environment,
    } as any);

    return { key: rawKey, keyPrefix };
  }

  async listApiKeys(merchantId: string) {
    return db.query.apiKeys.findMany({
      where: eq(apiKeys.merchantId, merchantId),
      columns: { id: true, keyPrefix: true, environment: true, isActive: true, createdAt: true },
    });
  }

  async revokeApiKey(merchantId: string, keyId: string) {
    const [key] = await db
      .update(apiKeys)
      .set({ isActive: false } as any)
      .where(eq(apiKeys.id, keyId))
      .returning();
    if (!key || key.merchantId !== merchantId) {
      throw new NotFoundException('API key not found');
    }
    return { revoked: true };
  }

  async setWebhook(merchantId: string, webhookUrl: string) {
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const [updated] = await db
      .update(merchants)
      .set({ webhookUrl, webhookSecret } as any)
      .where(eq(merchants.id, merchantId))
      .returning();
    return { webhookUrl: updated.webhookUrl, webhookSecret };
  }

  async validateApiKey(rawKey: string): Promise<string | null> {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const key = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.keyHash, keyHash),
    });
    if (!key || !key.isActive) return null;
    return key.merchantId;
  }
}
