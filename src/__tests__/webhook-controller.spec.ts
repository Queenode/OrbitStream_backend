import { NotFoundException } from '@nestjs/common';
import { WebhookController } from '../webhook/webhook.controller';

const REQ = { user: { walletAddress: 'GWALLET' } };
const MERCHANT = { id: 'merchant-1' };

function build() {
  const webhooks = {
    listDeliveries: jest.fn().mockResolvedValue([]),
    listDeadLetters: jest.fn().mockResolvedValue([]),
    retryDeadLetter: jest.fn(),
    dismissDeadLetter: jest.fn(),
  };
  const merchants = { findByWallet: jest.fn().mockResolvedValue(MERCHANT) };
  const controller = new WebhookController(webhooks as any, merchants as any);
  return { controller, webhooks, merchants };
}

describe('WebhookController', () => {
  it('is JWT-guarded at the class level', () => {
    const guards = Reflect.getMetadata('__guards__', WebhookController);
    expect(guards).toBeDefined();
    expect(guards).toHaveLength(1);
  });

  describe('merchant scoping', () => {
    it('resolves the merchant from the JWT wallet and scopes deliveries to it', async () => {
      const { controller, webhooks, merchants } = build();
      await controller.listDeliveries(REQ);
      expect(merchants.findByWallet).toHaveBeenCalledWith('GWALLET');
      expect(webhooks.listDeliveries).toHaveBeenCalledWith('merchant-1', 50);
    });

    it('throws NotFound when the wallet has no merchant', async () => {
      const { controller, merchants } = build();
      merchants.findByWallet.mockResolvedValue(null);
      await expect(controller.listDeliveries(REQ)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('limit clamping', () => {
    it.each([
      ['999999', 100],
      ['10', 10],
      ['0', 50],
      ['-5', 50],
      [undefined, 50],
      ['abc', 50],
    ])('maps ?limit=%s to %i', async (input, expected) => {
      const { controller, webhooks } = build();
      await controller.listDeliveries(REQ, input as any);
      expect(webhooks.listDeliveries).toHaveBeenCalledWith('merchant-1', expected);
    });
  });

  describe('dead-letter retry', () => {
    it('returns a requeued status with the new delivery id', async () => {
      const { controller, webhooks } = build();
      webhooks.retryDeadLetter.mockResolvedValue({ deliveryId: 'new-id' });
      const res = await controller.retryDeadLetter(REQ, 'dl-1');
      expect(webhooks.retryDeadLetter).toHaveBeenCalledWith('merchant-1', 'dl-1');
      expect(res).toEqual({ status: 'requeued', deliveryId: 'new-id' });
    });

    it('throws NotFound when the entry does not exist / belongs to another merchant', async () => {
      const { controller, webhooks } = build();
      webhooks.retryDeadLetter.mockResolvedValue(null);
      await expect(controller.retryDeadLetter(REQ, 'dl-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('dead-letter dismiss', () => {
    it('returns a dismissed status on success', async () => {
      const { controller, webhooks } = build();
      webhooks.dismissDeadLetter.mockResolvedValue(true);
      const res = await controller.dismissDeadLetter(REQ, 'dl-1');
      expect(webhooks.dismissDeadLetter).toHaveBeenCalledWith('merchant-1', 'dl-1');
      expect(res).toEqual({ status: 'dismissed' });
    });

    it('throws NotFound when nothing was deleted', async () => {
      const { controller, webhooks } = build();
      webhooks.dismissDeadLetter.mockResolvedValue(false);
      await expect(controller.dismissDeadLetter(REQ, 'dl-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
