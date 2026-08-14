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
    JOBS_ENABLED: 'false',
    // The coarse limiter has its own suite. Everywhere else it is a ceiling nobody should reach:
    // suites make hundreds of mutations from one address, and a limiter tripping mid-suite would
    // fail assertions about something else entirely.
    COARSE_LIMIT_BURST: '100000',
    COARSE_LIMIT_PER_MINUTE: '100000',
    SEARCH_LIMIT_BURST: '100000',
    SEARCH_LIMIT_PER_MINUTE: '100000',
    // Non-zero: the config schema rejects an all-zero key so a placeholder cannot reach
    // production. Fixed rather than random so failures stay reproducible.
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }
}
