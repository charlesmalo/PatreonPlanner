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
