import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  onModuleInit(): void {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 100, 5_000),
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    this.client.on('error', (err: Error) => this.logger.error('Redis client error', err.message));
    this.client.on('ready', () => this.logger.log('Redis connected'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  getClient(): Redis {
    return this.client;
  }
}
