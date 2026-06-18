import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const apiKeyEnvironmentEnum = pgEnum('api_key_environment', ['testnet', 'mainnet']);

export const sessionStatusEnum = pgEnum('session_status', [
  'pending',
  'paid',
  'expired',
  'cancelled',
]);

export const merchants = pgTable('merchants', {
  id: uuid('id').defaultRandom().primaryKey(),
  walletAddress: text('wallet_address').notNull().unique(),
  businessName: text('business_name').notNull(),
  email: text('email').notNull().unique(),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  logoUrl: text('logo_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  environment: apiKeyEnvironmentEnum('environment').notNull().default('testnet'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const checkoutSessions = pgTable('checkout_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  amount: numeric('amount', { precision: 36, scale: 7 }).notNull(),
  assetCode: text('asset_code').notNull(),
  assetIssuer: text('asset_issuer'),
  receivingAccount: text('receiving_account').notNull(),
  memo: text('memo'),
  status: sessionStatusEnum('status').notNull().default('pending'),
  successUrl: text('success_url'),
  cancelUrl: text('cancel_url'),
  metadata: jsonb('metadata'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const payments = pgTable('payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => checkoutSessions.id, { onDelete: 'cascade' }),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id),
  txHash: text('tx_hash').notNull().unique(),
  amount: numeric('amount', { precision: 36, scale: 7 }).notNull(),
  assetCode: text('asset_code').notNull(),
  assetIssuer: text('asset_issuer'),
  senderAddress: text('sender_address').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  responseStatus: integer('response_status'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const schema = {
  merchants,
  apiKeys,
  checkoutSessions,
  payments,
  webhookDeliveries,
};
