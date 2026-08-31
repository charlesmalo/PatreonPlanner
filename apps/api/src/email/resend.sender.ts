import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { EmailSender, type Email } from './email-sender';

/**
 * The only file that knows which provider this is.
 *
 * Their free tier is 3,000 a month and 100 a day. A daily digest is one email per reader, so that
 * is roughly a hundred readers — the ceiling worth knowing before it is reached rather than after.
 */
@Injectable()
export class ResendSender extends EmailSender {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(email: Email): Promise<void> {
    const response = await fetch(`${this.config.get('RESEND_API_BASE_URL')}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.get('DIGEST_FROM'),
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
    });

    // Thrown rather than swallowed: the caller leaves the watermark alone on a failure, so today's
    // news stays in tomorrow's digest. Swallowing it here would lose the day silently.
    if (!response.ok) {
      throw new Error(`Resend refused the message: ${response.status}`);
    }
  }
}
