import { Module } from '@nestjs/common';
import { PaymentDetectorService } from './payment-detector.service';
import { PaymentCursorService } from './payment-cursor.service';
import { StellarModule } from '../stellar/stellar.module';
import { WebhookModule } from '../webhook/webhook.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [StellarModule, WebhookModule, MonitoringModule],
  providers: [PaymentDetectorService, PaymentCursorService],
})
export class PaymentsModule {}
