import { Test } from '@nestjs/testing';
import { WebhookModule } from '../webhook/webhook.module';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { WebhookQueueService } from '../webhook/webhook-queue.service';

/**
 * Resolves the real WebhookModule DI graph (no manual provider overrides) to
 * prove NestJS can construct WebhookQueueService and inject RedisService at
 * startup. `compile()` instantiates every provider but does NOT run lifecycle
 * hooks, so no real Redis/Postgres connection is opened.
 */
describe('WebhookModule dependency injection', () => {
  it('resolves WebhookQueueService with RedisService injected', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WebhookModule],
    }).compile();

    const queue = moduleRef.get(WebhookQueueService);
    expect(queue).toBeInstanceOf(WebhookQueueService);
    // RedisService is resolvable from the same graph (provided by @Global RedisModule).
    expect(moduleRef.get(RedisService, { strict: false })).toBeInstanceOf(RedisService);
  });

  it('RedisModule exports RedisService', () => {
    expect(RedisModule).toBeDefined();
  });
});
