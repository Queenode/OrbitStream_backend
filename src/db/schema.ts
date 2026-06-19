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

export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'dead',
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
  // Nullable: not every webhook event belongs to a checkout session.
  sessionId: uuid('session_id').references(() => checkoutSessions.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  // Stable per-delivery idempotency identifier sent as X-OrbitStream-Delivery-Id.
  deliveryId: uuid('delivery_id').notNull().unique(),
  // Per-session ordering sequence number (0 for session-less events).
  sequence: integer('sequence').notNull().default(0),
  priority: integer('priority').notNull().default(3),
  status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
  responseStatus: integer('response_status'),
  // Full history of attempts: [{ attempt, timestamp, status, error }].
  attemptLog: jsonb('attempt_log').notNull().default([]),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const webhookDeadLetters = pgTable('webhook_dead_letters', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id),
  deliveryId: uuid('delivery_id').notNull().unique(),
  // References the session but uses ON DELETE SET NULL: a dead-letter row is a
  // retained audit/recovery record that must outlive a cascade-deleted session.
  sessionId: uuid('session_id').references(() => checkoutSessions.id, {
    onDelete: 'set null',
  }),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  // All delivery attempts with timestamps and error messages.
  attempts: jsonb('attempts').notNull().default([]),
  // Reason the delivery was dead-lettered (e.g. "4xx:404", "max_attempts").
  reason: text('reason').notNull(),
  // Set when a merchant manually requeues this entry.
  retriedAt: timestamp('retried_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const schema = {
  merchants,
  apiKeys,
  checkoutSessions,
  payments,
  webhookDeliveries,
  webhookDeadLetters,
};
