/**
 * The address to hold a caller accountable for.
 *
 * Both wrong answers are bad in different ways, which is why the hop count is configuration
 * rather than a default: trust too much and any client forges its identity by stuffing
 * `X-Forwarded-For` — evading its own limit *and* exhausting someone else's — while trusting too
 * little makes everyone behind a proxy share one bucket.
 *
 * Hops are counted from the **right**. `X-Forwarded-For` grows left-to-right as it passes through
 * proxies, so with one trusted proxy the last entry is the one that proxy wrote, which the client
 * cannot control. Anything further left is whatever the client sent.
 */
export function clientIp(
  request: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> },
  trustedHops: number,
): string {
  const socketAddress = request.socket?.remoteAddress ?? request.ip ?? 'unknown';
  if (trustedHops <= 0) return socketAddress;

  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
  const hops = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Fewer entries than proxies we expect means the header was not written by those proxies;
  // believing it would be believing the client.
  if (hops.length < trustedHops) return socketAddress;
  return hops[hops.length - trustedHops] ?? socketAddress;
}

/**
 * Whether an address looks like a proxy sitting in front of us rather than a real client.
 *
 * With `TRUSTED_PROXY_HOPS` unset behind a proxy, *every* request presents the proxy's address
 * and shares one bucket — so one client sustaining a few requests a second refuses every mutating
 * request for everybody, permanently. The limiter would be the outage it exists to prevent. When
 * the address looks like a proxy and we were told to trust nothing, the per-IP bucket is skipped
 * rather than applied to the whole internet at once.
 */
export function looksLikeProxy(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  return (
    ip === 'unknown' ||
    ip === '::1' ||
    ip === '127.0.0.1' ||
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^f[cd]/i.test(ip)
  );
}
