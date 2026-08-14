import { clientIp } from '../src/limits/client-ip';

const req = (opts: { socket?: string; xff?: string }) => ({
  socket: { remoteAddress: opts.socket },
  headers: opts.xff === undefined ? {} : { 'x-forwarded-for': opts.xff },
});

describe('clientIp', () => {
  it('uses the socket address when nothing is trusted', () => {
    // The one answer a client cannot forge.
    expect(clientIp(req({ socket: '203.0.113.9', xff: '1.2.3.4' }), 0)).toBe('203.0.113.9');
  });

  it('ignores a forged X-Forwarded-For when nothing is trusted', () => {
    expect(clientIp(req({ socket: '203.0.113.9', xff: 'evil, 1.2.3.4' }), 0)).toBe('203.0.113.9');
  });

  it('takes the hop written by the trusted proxy', () => {
    // One proxy in front: the last entry is the one that proxy wrote.
    expect(clientIp(req({ socket: '10.0.0.1', xff: 'client, 198.51.100.7' }), 1)).toBe(
      '198.51.100.7',
    );
  });

  it('counts hops from the right, not the left', () => {
    expect(clientIp(req({ socket: '10.0.0.1', xff: 'spoofed, real, p1, p2' }), 3)).toBe('real');
  });

  it('cannot be pushed off the end by extra entries', () => {
    // Stuffing the header must not shift the trusted position onto attacker-controlled data.
    const honest = clientIp(req({ socket: '10.0.0.1', xff: 'client, 198.51.100.7' }), 1);
    const stuffed = clientIp(
      req({ socket: '10.0.0.1', xff: 'a, b, c, d, client, 198.51.100.7' }),
      1,
    );
    expect(stuffed).toBe(honest);
  });

  it('falls back to the socket when the header is shorter than the trusted depth', () => {
    // Fewer entries than proxies we expect means those proxies did not write it.
    expect(clientIp(req({ socket: '10.0.0.1', xff: 'client' }), 2)).toBe('10.0.0.1');
  });

  it('falls back to the socket when the header is absent', () => {
    expect(clientIp(req({ socket: '10.0.0.1' }), 1)).toBe('10.0.0.1');
  });

  it('never returns an empty string', () => {
    expect(clientIp(req({ xff: '  ,  ' }), 1)).toBe('unknown');
    expect(clientIp(req({}), 0)).toBe('unknown');
  });
});
