import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { db } from '../db/index';
import { checkoutSessions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';

@Injectable()
export class CheckoutService {
  private readonly frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  private readonly sessionTtlMinutes = Number(process.env.CHECKOUT_SESSION_TTL_MINUTES ?? 30);

  async createSession(
    merchantId: string,
    dto: {
      amount: number;
      asset: string;
      assetIssuer?: string;
      successUrl?: string;
      cancelUrl?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const memo = crypto.randomBytes(8).toString('hex');
    const receivingAccount = process.env.PLATFORM_RECEIVING_ACCOUNT;
    if (!receivingAccount) {
      throw new BadRequestException('Platform receiving account not configured');
    }

    const expiresAt = new Date(Date.now() + this.sessionTtlMinutes * 60 * 1000);

    const [session] = await db
      .insert(checkoutSessions)
      .values({
        merchantId,
        amount: dto.amount.toString(),
        assetCode: dto.asset,
        assetIssuer: dto.assetIssuer ?? null,
        receivingAccount,
        memo,
        status: 'pending',
        successUrl: dto.successUrl ?? null,
        cancelUrl: dto.cancelUrl ?? null,
        metadata: dto.metadata ?? null,
        expiresAt,
      } as any)
      .returning();

    const url = `${this.frontendUrl}/checkout/${session.id}`;

    return {
      id: session.id,
      url,
      amount: session.amount,
      asset: session.assetCode,
      status: session.status,
      expiresAt: session.expiresAt,
    };
  }

  async getSession(sessionId: string) {
    const session = await db.query.checkoutSessions.findFirst({
      where: eq(checkoutSessions.id, sessionId),
    });
    if (!session) throw new NotFoundException('Session not found');

    if (session.status === 'pending' && new Date() > session.expiresAt) {
      await db
        .update(checkoutSessions)
        .set({ status: 'expired' } as any)
        .where(eq(checkoutSessions.id, sessionId));
      return { ...session, status: 'expired' as const };
    }

    return session;
  }

  async cancelSession(sessionId: string, merchantId: string) {
    const session = await db.query.checkoutSessions.findFirst({
      where: and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.merchantId, merchantId)),
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.status !== 'pending') {
      throw new BadRequestException('Session is not pending');
    }

    const [updated] = await db
      .update(checkoutSessions)
      .set({ status: 'cancelled' } as any)
      .where(eq(checkoutSessions.id, sessionId))
      .returning();

    return updated;
  }

  async markAsPaid(sessionId: string) {
    const [updated] = await db
      .update(checkoutSessions)
      .set({ status: 'paid' } as any)
      .where(eq(checkoutSessions.id, sessionId))
      .returning();
    return updated;
  }
}
