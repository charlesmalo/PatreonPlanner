import { ConfigService } from '../src/config/config.module';
import { HttpPatreonClient } from '../src/patreon/http-patreon.client';
import { applyTestConfigDefaults } from './support/env';

describe('HttpPatreonClient.fetchOwnedCampaigns', () => {
  let client: HttpPatreonClient;
  const originalFetch = global.fetch;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    client = new HttpPatreonClient(new ConfigService());
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('flattens campaigns and their tiers, ordered by pledge amount', async () => {
    const payload = {
      data: [
        {
          id: 'campaign-1',
          attributes: { creation_name: 'Ada Writes' },
          relationships: { tiers: { data: [{ id: 'tier-hi' }, { id: 'tier-lo' }] } },
        },
      ],
      included: [
        { id: 'tier-hi', type: 'tier', attributes: { title: 'Gold', amount_cents: 1000 } },
        { id: 'tier-lo', type: 'tier', attributes: { title: 'Bronze', amount_cents: 300 } },
        { id: 'someone-else', type: 'tier', attributes: { title: 'Other', amount_cents: 100 } },
      ],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const campaigns = await client.fetchOwnedCampaigns('token');

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].campaignId).toBe('campaign-1');
    expect(campaigns[0].displayName).toBe('Ada Writes');
    // Ascending by amount, and `order` follows that ranking rather than payload order — an
    // unrelated tier in `included` must not be attributed to this campaign.
    expect(campaigns[0].tiers).toEqual([
      { patreonTierId: 'tier-lo', title: 'Bronze', amountCents: 300, order: 0 },
      { patreonTierId: 'tier-hi', title: 'Gold', amountCents: 1000, order: 1 },
    ]);
  });

  it('returns an empty list when the user owns no campaigns', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as unknown as Response);
    expect(await client.fetchOwnedCampaigns('token')).toEqual([]);
  });

  it('tolerates a campaign with no tiers', async () => {
    const payload = { data: [{ id: 'campaign-2', attributes: { creation_name: 'Bare' } }] };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);
    const campaigns = await client.fetchOwnedCampaigns('token');
    expect(campaigns[0].tiers).toEqual([]);
  });

  it('falls back to a placeholder name rather than storing undefined', async () => {
    const payload = { data: [{ id: 'campaign-3' }] };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);
    const campaigns = await client.fetchOwnedCampaigns('token');
    expect(campaigns[0].displayName).toBe('Untitled campaign');
  });

  it('throws without leaking the response body when Patreon rejects the call', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
    await expect(client.fetchOwnedCampaigns('token')).rejects.toThrow(
      'Patreon campaign lookup failed',
    );
  });
});
