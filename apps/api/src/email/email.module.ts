import { Module } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { DigestJob } from './digest.job';
import { DigestService } from './digest.service';
import { EmailSender, NoopEmailSender } from './email-sender';
import { ResendSender } from './resend.sender';
import { EmailDigestController } from './email-digest.controller';
import { UnsubscribeController } from './unsubscribe.controller';
import { UnsubscribeTokenService } from './unsubscribe-token.service';

@Module({
  controllers: [UnsubscribeController, EmailDigestController],
  providers: [
    DigestService,
    DigestJob,
    UnsubscribeTokenService,
    NoopEmailSender,
    ResendSender,
    {
      // Chosen at boot from what is configured. An instance with no key gets the no-op and runs
      // perfectly well — self-hosted, in development, or simply not wanting to send anything.
      provide: EmailSender,
      inject: [ConfigService, ResendSender, NoopEmailSender],
      useFactory: (config: ConfigService, resend: ResendSender, noop: NoopEmailSender) =>
        config.get('RESEND_API_KEY') ? resend : noop,
    },
  ],
  exports: [DigestService, DigestJob, UnsubscribeTokenService],
})
export class EmailModule {}
