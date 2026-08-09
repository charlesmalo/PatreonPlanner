/**
 * The config schema validates the whole environment at boot, so even a test that only cares
 * about infrastructure has to satisfy the Patreon and crypto keys. These are inert values for
 * suites that never exercise them; anything the environment already provides wins, so CI's
 * values and a developer's .env are never overwritten.
 */
export function applyTestConfigDefaults(): void {
  const defaults: Record<string, string> = {
    PATREON_CLIENT_ID: 'test-client-id',
    PATREON_CLIENT_SECRET: 'test-client-secret',
    PATREON_REDIRECT_URI: 'http://localhost:3000/auth/patreon/callback',
    PATREON_WEBHOOK_SECRET: 'test-webhook-secret',
    JOBS_ENABLED: 'false',
    // Non-zero: the config schema rejects an all-zero key so a placeholder cannot reach
    // production. Fixed rather than random so failures stay reproducible.
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }
}
