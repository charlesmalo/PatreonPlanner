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
/**
 * Off by default so the e2e suite keeps getting a silent approval — it sets the identity through
 * `/__control` and expects the redirect to happen without a click. The demo turns it on, so
 * "Sign in with Patreon" asks who you are instead of silently reusing whoever went last.
 */
const CONSENT_SCREEN = process.env.STUB_CONSENT_SCREEN === 'true';

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
  // Beyond what the e2e suite needs, and deliberately so: the first playtester typed a famous
  // show, got nothing, and reasonably read the empty dropdown as a broken search rather than a
  // two-film fixture. These are the titles someone actually reaches for, including several that
  // share a franchise so nesting and grouping have something to work with.
  {
    id: 85937,
    media_type: 'tv',
    name: 'Demon Slayer: Kimetsu no Yaiba',
    first_air_date: '2019-04-06',
    poster_path: '/demonslayer.jpg',
    overview: 'A boy sells charcoal until a demon takes his family.',
    genres: [{ name: 'Animation' }, { name: 'Action & Adventure' }],
  },
  {
    id: 65942,
    media_type: 'tv',
    name: 'Re:ZERO -Starting Life in Another World-',
    first_air_date: '2016-04-04',
    poster_path: '/rezero.jpg',
    overview: 'A boy is pulled into another world, and dies his way through it.',
    genres: [{ name: 'Animation' }, { name: 'Sci-Fi & Fantasy' }],
  },
  {
    id: 30991,
    media_type: 'tv',
    name: 'Cowboy Bebop',
    first_air_date: '1998-04-03',
    poster_path: '/bebop.jpg',
    overview: 'Bounty hunters chase a living across the solar system.',
    genres: [{ name: 'Animation' }, { name: 'Sci-Fi & Fantasy' }],
  },
  {
    id: 1429,
    media_type: 'tv',
    name: 'Attack on Titan',
    first_air_date: '2013-04-07',
    poster_path: '/aot.jpg',
    overview: 'Humanity lives behind walls, and the walls stop being enough.',
    genres: [{ name: 'Animation' }, { name: 'Action & Adventure' }],
  },
  {
    id: 149,
    media_type: 'movie',
    title: 'Akira',
    release_date: '1988-07-16',
    poster_path: '/akira.jpg',
    overview: 'Neo-Tokyo, a biker gang, and a power nobody can hold.',
    genres: [{ name: 'Animation' }, { name: 'Science Fiction' }],
  },
  {
    id: 372058,
    media_type: 'movie',
    title: 'Your Name.',
    release_date: '2016-08-26',
    poster_path: '/yourname.jpg',
    overview: 'Two strangers keep waking up in each other\u2019s lives.',
    genres: [{ name: 'Animation' }, { name: 'Romance' }],
  },
  {
    id: 4935,
    media_type: 'movie',
    title: "Howl's Moving Castle",
    release_date: '2004-11-20',
    poster_path: '/howl.jpg',
    overview: 'A hat-maker is cursed into old age and takes work in a walking castle.',
    belongs_to_collection: { id: 10, name: 'Studio Ghibli Collection' },
    genres: [{ name: 'Animation' }],
  },
  {
    id: 128,
    media_type: 'movie',
    title: 'Princess Mononoke',
    release_date: '1997-07-12',
    poster_path: '/mononoke.jpg',
    overview: 'A prince walks into a war between a forest and an ironworks.',
    belongs_to_collection: { id: 10, name: 'Studio Ghibli Collection' },
    genres: [{ name: 'Animation' }],
  },
  {
    id: 110316,
    media_type: 'tv',
    name: 'Alice in Borderland',
    first_air_date: '2020-12-10',
    poster_path: '/alice.jpg',
    overview: 'Tokyo empties, and the games begin.',
    genres: [{ name: 'Sci-Fi & Fantasy' }, { name: 'Drama' }],
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
    const chosen = url.searchParams.get('persona');

    if (chosen && PERSONAS[chosen]) {
      identity = PERSONAS[chosen].identity;
      memberships = PERSONAS[chosen].memberships;
      campaigns = PERSONAS[chosen].campaigns;
    } else if (CONSENT_SCREEN) {
      // The real consent screen asks a question; so does this one. Without it the button signs
      // you in as whoever went last, which makes it impossible to see the two sides of anything
      // — a report and the moderator who receives it, say.
      const rows = Object.entries(PERSONAS)
        .map(([key, p]) => {
          const href = `${url.pathname}?${new URLSearchParams({
            ...Object.fromEntries(url.searchParams),
            persona: key,
          })}`;
          return `<li><a href="${href}">${p.identity.full_name}</a> — ${p.note}</li>`;
        })
        .join('');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(
        `<!doctype html><meta charset="utf-8"><title>Approve access</title>` +
          `<body style="font:16px system-ui;max-width:34rem;margin:3rem auto">` +
          `<h1>Continue as…</h1><ul>${rows}</ul>` +
          `<p style="color:#666">Standing in for Patreon's consent screen.</p></body>`,
      );
    }

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
