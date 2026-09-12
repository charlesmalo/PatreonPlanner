import { ConfigService } from '../src/config/config.module';
import { ResendSender } from '../src/email/resend.sender';
import { applyTestConfigDefaults } from './support/env';

/**
 * The only file that knows which email provider this is — and the only one whose `send` had never
 * been called by a test. Found by the per-file coverage floor, not by anything failing: 8 of its
 * 11 statements ran, which is 72.72% inside an API aggregate of 97.3%.
 *
 * The failure branch is the one worth pinning. It throws rather than swallowing, because the
 * caller leaves the digest watermark alone on a failure so today's news stays in tomorrow's
 * digest. A sender that swallowed the error would lose a day of email silently, and every test
 * above this one would still pass.
 */
describe('ResendSender', () => {
  let sender: ResendSender;
  const originalFetch = global.fetch;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    sender = new ResendSender(new ConfigService());
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const email = { to: 'ada@example.com', subject: 'Your digest', text: 'Two new entries.' };

  it('posts the message to the provider as the configured sender', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
    global.fetch = fetchMock;

    await sender.send(email);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/emails$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: ['ada@example.com'],
      subject: 'Your digest',
      text: 'Two new entries.',
    });
  });

  it('throws when the provider refuses, so the caller can keep the day in tomorrow’s digest', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 } as unknown as Response);

    await expect(sender.send(email)).rejects.toThrow('Resend refused the message: 429');
  });
});
