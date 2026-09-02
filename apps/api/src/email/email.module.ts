import { Module } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { DigestJob } from './digest.job';
import { DigestService } from './digest.service';
import { EmailSender, NoopEmailSender } from './email-sender';
import { ResendSender } from './resend.sender';
import { EmailDigestController } from './email-digest.controller';
import { ResendWebhookAdapter } from './resend-webhook.adapter';
import { ResendWebhookController } from './resend-webhook.controller';
import { SuppressingEmailSender } from './suppressing.sender';
import { SuppressionService } from './suppression.service';
import { UnsubscribeController } from './unsubscribe.controller';
import { UnsubscribeTokenService } from './unsubscribe-token.service';

@Module({
  controllers: [UnsubscribeController, EmailDigestController, ResendWebhookController],
  providers: [
    DigestService,
    DigestJob,
    UnsubscribeTokenService,
    NoopEmailSender,
    ResendSender,
    ResendWebhookAdapter,
    SuppressionService,
    {
      // Chosen at boot from what is configured, then wrapped so the suppression list applies to
      // everything this application sends rather than only to the digest. The no-op is wrapped
      // too: an instance that sends nothing should still behave identically in tests.
      provide: EmailSender,
      inject: [ConfigService, ResendSender, NoopEmailSender, SuppressionService],
      useFactory: (
        config: ConfigService,
        resend: ResendSender,
        noop: NoopEmailSender,
        suppressions: SuppressionService,
      ) => new SuppressingEmailSender(config.get('RESEND_API_KEY') ? resend : noop, suppressions),
    },
  ],
  exports: [DigestService, DigestJob, UnsubscribeTokenService, SuppressionService],
})
export class EmailModule {}
