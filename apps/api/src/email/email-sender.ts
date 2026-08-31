import { Injectable, Logger } from '@nestjs/common';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sending, with the provider behind it.
 *
 * One interface so that Resend, Brevo or anything else is one file rather than a search across
 * the codebase — the same shape the payment adapter takes, and for the same reason.
 */
export abstract class EmailSender {
  /** Resolves when the provider accepted it. Throws when it did not; the caller decides. */
  abstract send(email: Email): Promise<void>;
}

/**
 * What an instance with no provider configured uses.
 *
 * Not an error and not a silent success: it logs, so a developer who expected mail can see why
 * none arrived. An instance that sends nothing is a perfectly good instance — self-hosted, in
 * development, or simply not wanting to.
 */
@Injectable()
export class NoopEmailSender extends EmailSender {
  private readonly logger = new Logger(NoopEmailSender.name);

  async send(email: Email): Promise<void> {
    this.logger.log(`No email provider configured; would have sent "${email.subject}"`);
  }
}
