jest.mock('axios');
import axios from 'axios';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { signPayload } from '../webhook/webhook.constants';

const mockedPost = axios.post as jest.Mock;

const TARGET = { url: 'https://merchant.example/webhook', secret: 'whsec_123' };
const REQ = {
  deliveryId: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-06-19T00:00:00.000Z',
  event: 'payment.confirmed',
  sequence: 1,
  payload: JSON.stringify({ event: 'payment.confirmed', data: { sessionId: 's1' } }),
};

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;

  beforeEach(() => {
    service = new WebhookDeliveryService();
    mockedPost.mockReset();
  });

  it('marks 2xx responses as success', async () => {
    mockedPost.mockResolvedValue({ status: 200 });
    const res = await service.deliver(TARGET, REQ);
    expect(res).toEqual({ outcome: 'success', status: 200, error: null });
  });

  it('dead-letters 4xx responses without retrying', async () => {
    mockedPost.mockResolvedValue({ status: 404 });
    const res = await service.deliver(TARGET, REQ);
    expect(res.outcome).toBe('dead');
    expect(res.status).toBe(404);
  });

  it('retries on 5xx responses', async () => {
    mockedPost.mockResolvedValue({ status: 503 });
    const res = await service.deliver(TARGET, REQ);
    expect(res.outcome).toBe('retry');
    expect(res.status).toBe(503);
  });

  it('retries on network errors / timeouts', async () => {
    mockedPost.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    const res = await service.deliver(TARGET, REQ);
    expect(res.outcome).toBe('retry');
    expect(res.status).toBeNull();
    expect(res.error).toContain('ECONNABORTED');
  });

  it('sends idempotency + signature headers with a 10s timeout', async () => {
    mockedPost.mockResolvedValue({ status: 200 });
    await service.deliver(TARGET, REQ);

    const [url, body, config] = mockedPost.mock.calls[0];
    expect(url).toBe(TARGET.url);
    expect(body).toBe(REQ.payload);
    expect(config.timeout).toBe(10_000);

    const expectedSig = signPayload(TARGET.secret, REQ.deliveryId, REQ.timestamp, REQ.payload);
    expect(config.headers['X-OrbitStream-Delivery-Id']).toBe(REQ.deliveryId);
    expect(config.headers['X-OrbitStream-Timestamp']).toBe(REQ.timestamp);
    expect(config.headers['X-OrbitStream-Event']).toBe(REQ.event);
    expect(config.headers['X-OrbitStream-Signature']).toBe(`sha256=${expectedSig}`);
  });

  it('keeps the same signature when the same delivery is retried (stable idempotency)', async () => {
    mockedPost.mockResolvedValue({ status: 500 });
    await service.deliver(TARGET, REQ);
    await service.deliver(TARGET, REQ);
    const sig1 = mockedPost.mock.calls[0][2].headers['X-OrbitStream-Signature'];
    const sig2 = mockedPost.mock.calls[1][2].headers['X-OrbitStream-Signature'];
    expect(sig1).toBe(sig2);
  });
});
