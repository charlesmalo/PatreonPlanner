import { createServer } from 'node:http';

/**
 * Stands in for Patreon so the end-to-end suite can drive a genuine login without the network.
 *
 * It is deliberately a separate process reached over HTTP rather than an in-process fake: the
 * point of these tests is to exercise the real containers, the real nginx proxy and the real
 * cookie flow. A fake injected into the API would test a different application.
 */
const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8080';

// Whoever the next login should be. Tests set this to switch identities.
let identity = {
  id: 'patreon-user-e2e',
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  image_url: 'https://example.com/ada.png',
};
let memberships = [];
let campaigns = [];
// TMDB stand-in. Same process because it is the same kind of thing — a third party the API and
// the browser both talk to — and one container is easier to reason about than two.
let catalog = [
  {
    id: 129,
    media_type: 'movie',
    title: 'Spirited Away',
    release_date: '2001-07-20',
    poster_path: '/spirited.jpg',
    overview: 'A girl wanders into a world of spirits.',
    // Drives the relation builder: the film nests under this collection once enriched.
    belongs_to_collection: { id: 10, name: 'Studio Ghibli Collection' },
    genres: [{ name: 'Animation' }],
  },
  {
    id: 8392,
    media_type: 'movie',
    title: 'My Neighbor Totoro',
    release_date: '1988-04-16',
    poster_path: '/totoro.jpg',
    overview: 'Two sisters meet a forest spirit.',
    belongs_to_collection: { id: 10, name: 'Studio Ghibli Collection' },
    genres: [{ name: 'Animation' }],
  },
];

// Collections are a separate TMDB search endpoint and a separate detail path, so they are a
// separate fixture here too.
let collections = [
  {
    id: 10,
    name: 'Studio Ghibli Collection',
    poster_path: '/ghibli.jpg',
    overview: 'Films from Studio Ghibli.',
  },
];

/**
 * Named people the demo stack can sign in as. The e2e suite drives identity through `/__control`;
 * a human playtester needs something they can click, and switching account has to be one step or
 * nobody will try the board from more than one angle.
 *
 * Kept in step with apps/api/scripts/seed-demo.ts.
 */
const PERSONAS = {
  ada: {
    identity: { id: 'demo-ada', full_name: 'Ada Lovelace', email: 'ada@example.com' },
    memberships: [],
    campaigns: [{ campaignId: 'demo-campaign', displayName: 'Ada Watches Things' }],
    note: 'owner of the board',
  },
  mo: {
    identity: { id: 'demo-mo', full_name: 'Mo Ferran', email: 'mo@example.com' },
    memberships: [],
    campaigns: [],
    note: 'moderator',
  },
  bea: {
    identity: { id: 'demo-bea', full_name: 'Bea Okonjo', email: 'bea@example.com' },
    memberships: [{ campaignId: 'demo-campaign', amountCents: 500, isActivePatron: true }],
    campaigns: [],
    note: 'patron, $5 tier',
  },
  cal: {
    identity: { id: 'demo-cal', full_name: 'Cal Nguyen', email: 'cal@example.com' },
    memberships: [{ campaignId: 'demo-campaign', amountCents: 1500, isActivePatron: true }],
    campaigns: [],
    note: 'patron, $15 tier',
  },
  dee: {
    identity: { id: 'demo-dee', full_name: 'Dee Alvarez', email: 'dee@example.com' },
    memberships: [{ campaignId: 'demo-campaign', amountCents: 0, isActivePatron: false }],
    campaigns: [],
    note: 'lapsed patron — can read, cannot submit',
  },
};

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Test control surface.
  if (url.pathname === '/__control' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.identity) identity = { ...identity, ...body.identity };
    if (body.memberships) memberships = body.memberships;
    if (body.campaigns) campaigns = body.campaigns;
    if (body.catalog) catalog = body.catalog;
    return json(res, { ok: true });
  }

  // Who to be. Sets the identity the next login will report, then sends the browser into the
  // real login route — so the demo exercises the same OAuth flow as everything else rather than
  // a shortcut that skips it.
  const persona = url.pathname.match(/^\/__be\/([a-z]+)$/);
  if (persona) {
    const chosen = PERSONAS[persona[1]];
    if (!chosen) return json(res, { error: 'unknown persona' }, 404);
    identity = chosen.identity;
    memberships = chosen.memberships;
    campaigns = chosen.campaigns;
    res.writeHead(302, { Location: `${WEB_ORIGIN}/auth/patreon/login` });
    return res.end();
  }

  // A plain index, so the demo needs no cheat sheet open beside it.
  if (url.pathname === '/__be') {
    const rows = Object.entries(PERSONAS)
      .map(
        ([key, p]) =>
          `<li><a href="/__be/${key}">${p.identity.full_name}</a> — ${p.note}</li>`,
      )
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>Sign in as</title>` +
        `<body style="font:16px system-ui;max-width:34rem;margin:3rem auto">` +
        `<h1>Sign in as…</h1><ul>${rows}</ul>` +
        `<p>Signing in as someone else replaces the current session.</p></body>`,
    );
  }

  // The consent screen: approve immediately and bounce back with the state we were given, which
  // is what makes the browser-bound state cookie meaningful.
  if (url.pathname === '/oauth2/authorize') {
    const state = url.searchParams.get('state');
    const redirect = url.searchParams.get('redirect_uri') ?? `${WEB_ORIGIN}/auth/patreon/callback`;
    res.writeHead(302, { Location: `${redirect}?code=stub-code&state=${encodeURIComponent(state)}` });
    return res.end();
  }

  if (url.pathname === '/api/oauth2/token') {
    return json(res, {
      access_token: 'stub-access-token',
      refresh_token: 'stub-refresh-token',
      expires_in: 3600,
    });
  }

  if (url.pathname === '/api/oauth2/v2/identity') {
    const included = memberships.map((m, index) => ({
      id: `member-${index}`,
      type: 'member',
      attributes: {
        patron_status: m.isActivePatron ? 'active_patron' : 'former_patron',
        currently_entitled_amount_cents: m.amountCents,
      },
      relationships: {
        campaign: { data: { id: m.campaignId } },
        currently_entitled_tiers: { data: (m.tierIds ?? []).map((id) => ({ id })) },
      },
    }));
    return json(res, {
      data: {
        id: identity.id,
        attributes: {
          full_name: identity.full_name,
          email: identity.email,
          image_url: identity.image_url,
        },
        relationships: { memberships: { data: included.map((m) => ({ id: m.id })) } },
      },
      included,
    });
  }

  if (url.pathname === '/api/oauth2/v2/campaigns') {
    return json(res, {
      data: campaigns.map((c) => ({
        id: c.campaignId,
        attributes: { creation_name: c.displayName },
        relationships: { tiers: { data: (c.tiers ?? []).map((t) => ({ id: t.patreonTierId })) } },
      })),
      included: campaigns.flatMap((c) =>
        (c.tiers ?? []).map((t) => ({
          id: t.patreonTierId,
          type: 'tier',
          attributes: { title: t.title, amount_cents: t.amountCents },
        })),
      ),
    });
  }

  // TMDB routes.
  if (url.pathname === '/3/search/collection') {
    const query = (url.searchParams.get('query') ?? '').toLowerCase();
    return json(res, {
      results: collections.filter((c) => c.name.toLowerCase().includes(query)),
    });
  }

  const collection = url.pathname.match(/^\/3\/collection\/(\d+)$/);
  if (collection) {
    const item = collections.find((c) => c.id === Number(collection[1]));
    return item ? json(res, item) : json(res, { error: 'not found' }, 404);
  }

  if (url.pathname === '/3/search/multi') {
    const query = (url.searchParams.get('query') ?? '').toLowerCase();
    return json(res, {
      results: catalog.filter((item) => (item.title ?? item.name ?? '').toLowerCase().includes(query)),
    });
  }

  const providers = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)\/watch\/providers$/);
  if (providers) {
    const wanted = providers[1] === 'tv' ? 'tv' : 'movie';
    const item = catalog.find((c) => c.id === Number(providers[2]) && c.media_type === wanted);
    if (!item) return json(res, { error: 'not found' }, 404);
    return json(res, {
      id: item.id,
      results: {
        US: {
          link: `https://example.invalid/watch/${item.id}`,
          flatrate: [
            { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 },
          ],
        },
      },
    });
  }

  const keywords = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)\/keywords$/);
  if (keywords) {
    return json(res, { keywords: [{ name: 'anime' }] });
  }

  const similar = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)\/similar$/);
  if (similar) {
    return json(res, { results: [] });
  }

  const detail = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)$/);
  if (detail) {
    const wanted = detail[1] === 'tv' ? 'tv' : 'movie';
    const item = catalog.find((c) => c.id === Number(detail[2]) && c.media_type === wanted);
    return item ? json(res, item) : json(res, { error: 'not found' }, 404);
  }

  json(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => console.log(`patreon stub on :${PORT}`));
