import { Injectable, Logger } from '@nestjs/common';
import { EmailSender, type Email } from './email-sender';
import { SuppressionService } from './suppression.service';

/**
 * Every outgoing email, checked against the suppression list first.
 *
 * Wrapping the sender rather than filtering inside the digest is deliberate. The list protects the
 * sending domain's standing, which is a property of *sending* — so any future email path, a
 * password reset or a receipt or something not yet imagined, inherits the check without anybody
 * having to remember it. A filter in the digest would protect exactly one caller.
 *
 * A suppressed address is dropped quietly rather than raised: it is not a failure, and throwing
 * would make the digest job treat a correctly-skipped reader as an outage and hold the watermark
 * back for everybody.
 */
@Injectable()
export class SuppressingEmailSender extends EmailSender {
  private readonly logger = new Logger(SuppressingEmailSender.name);

  constructor(
    private readonly inner: EmailSender,
    private readonly suppressions: SuppressionService,
  ) {
    super();
  }

  async send(email: Email): Promise<void> {
    if (await this.suppressions.isSuppressed(email.to)) {
      // Not the address itself: this line ends up in logs that outlive the reason for keeping it.
      this.logger.log('Skipping a suppressed address');
      return;
    }
    await this.inner.send(email);
  }
}
