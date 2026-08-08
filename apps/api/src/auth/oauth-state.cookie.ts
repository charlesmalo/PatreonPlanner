/**
 * Binds an OAuth flow to the browser that started it. Without it the server would redeem any
 * unexpired state from any browser, so an attacker could complete consent with their own
 * Patreon account and then induce a victim to load the callback — handing the victim a session
 * authenticated as the attacker. Design §9 credits `state` with OAuth CSRF protection; that
 * protection only exists once the state is tied to a user agent.
 */
export const OAUTH_STATE_COOKIE = 'pp_oauth_state';

// Matches the Redis TTL on the pending state: the cookie is worthless once the state expires.
export const OAUTH_STATE_TTL_SECONDS = 600;
