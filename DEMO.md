# Playtest demo

A seeded board you can click around, running the same containers CI builds — the real API, the
real nginx proxy, the real OAuth flow. Patreon and TMDB are stubbed, because signing in to a real
campaign is not something a demo should need.

## Start it

```bash
docker compose -f docker-compose.demo.yml up -d --build
```

First run takes a few minutes to build. Then:

- **Start here** — <http://localhost:8081> — search for a creator and click through to their board
- **Sign in as…** — <http://localhost:4001/__be>

The board itself is at `/c/ada-watches-things`, but you should not need to type that: search for
"Ada" from the home page. Favourite a board with the star and it sorts to the top next time, above
boards you merely pay for.

Stop with `docker compose -f docker-compose.demo.yml down`. Add `-v` to throw the data away and
get a fresh board next time; without it, whatever you did survives the restart.

It runs on 8081/4001 so it can sit alongside the e2e stack (8080/4000) without either disturbing
the other.

## Who you can be

Pick from <http://localhost:4001/__be>. Signing in as someone else replaces your session, so the
way to see two sides of an interaction is to switch back and forth.

| Person       | What they are | What that means                                                  |
| ------------ | ------------- | ---------------------------------------------------------------- |
| Ada Lovelace | Owner         | Everything, including policy and the blocklist                   |
| Mo Ferran    | Moderator     | Moves entries, works the review queue — **cannot** change policy |
| Bea Okonjo   | Patron, $5    | Read, upvote, submit                                             |
| Cal Nguyen   | Patron, $15   | Same, on the higher tier                                         |
| Dee Alvarez  | Lapsed patron | Read only — cannot upvote or submit                              |
| _(nobody)_   | Signed out    | Read only, on a public board                                     |

The Mo/Ada split is worth poking at deliberately: a moderator who arrived by invite link can
moderate content but cannot make a paid board public or change the webhook secret. That was a real
bug found in review, and it is visible from the UI.

## Things worth trying

**The board, as a patron.** Sign in as Bea. Upvote something. Submit a title. Sign in as Dee and
watch the same controls disappear — a lapsed patron keeps reading but stops being able to act.

**Moderation.** As Mo, open the review queue. Paprika has been reported by Bea and is waiting.
Resolve it, or move an entry between Suggestions → Accepted → Now Playing → Completed. Then sign
back in as Bea and open the bell: she has been told what happened to hers, and she was not told
about anything she did herself.

**The blocklist.** As Ada, the board already blocks _ganondorf_ and flags _spoiler_:

```
POST /api/v1/creators/ada-watches-things/blocklist   { "pattern": "…", "action": "BLOCK" | "FLAG" }
```

Then as Bea, submit "The Ganondorf Cut" — refused. Submit something with "spoiler" in it — it goes
through, and a moderator finds it waiting. Both are recorded in `ModerationResult` with what
matched and why; the offending text itself is deliberately never stored.

**Search.** Try a misspelling ("cowbay bebop"), and try describing something instead of naming it.
Trigram matching and semantic search are fused, so both routes find the entry.

**Notifications.** The bell polls once a minute, so it is not instant by design. Opening it marks
what it showed as read, and nothing else.

## Driving it from a script

Sometimes it is easier to script the demo than to click it — capturing a screenshot, reproducing
a sequence, or checking that something survives a reload. Playwright is already a dev dependency
of `e2e`, so nothing new is needed.

Three things will trip you up, in the order you hit them.

**1. Sign-in goes through the real OAuth chain.** `/__be/<person>` — `ada`, `mo`, `bea`, `cal`,
`dee` — does not set a cookie directly. It redirects into `/auth/patreon/login` on the app, which
bounces through the stub and back. Wait for the app, not for the stub.

**2. There is a consent screen, and it lists _everybody_.** The stub shows "Continue as…" the way
Patreon shows an approve screen — but not with one link. It offers **all five personas**, each
carrying `?persona=<who>`, and `/__be/<who>` does not narrow that list.

So a script must click the link for the person it wants:

```js
page.locator(`a[href*="persona=${who}"]`).first(); // not .first() on the whole list
```

Taking the first link instead signs you in as **Ada**, whichever persona you asked for, and
nothing anywhere says so — the run succeeds, the header shows a name you did not choose, and any
conclusion you draw about permissions is about Ada. That mistake produced a confident and entirely
fictional table of what each persona can see, twice, before it was spotted.

Skipping the consent step altogether leaves you sitting on `/oauth2/authorize` wondering why
sign-in timed out.

**3. Columns are tabs, not side by side.** Only one column's panel is visible at a time and the
rest are `inert`, so anything outside the column the board opens on has to be asked for first.
This is true for a person too — it is why the board has Suggestions / Accepted / Now Playing /
Completed across the top rather than four columns at once.

An ES-module script has to live **inside `e2e/`**, or `@playwright/test` will not resolve:

```bash
cat > e2e/scratch.mjs <<'JS'
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });

const who = 'ada'; // ada · mo · bea · cal · dee
await page.goto(`http://localhost:4001/__be/${who}`);          // 1. pick a person
// 2. the consent screen lists every persona — click the one you asked for, not the first
const consent = page.locator(`a[href*="persona=${who}"]`).first();
if (await consent.count()) await consent.click();
await page.getByRole('button', { name: /sign out/i }).waitFor({ timeout: 20000 });

await page.goto('http://localhost:8081/c/ada-watches-things');
await page.getByRole('tab', { name: /suggestions/i }).click(); // 3. columns are tabs

const column = page.getByRole('region', { name: /suggestions/i });
await column.getByRole('heading', { level: 3 }).first().waitFor();
await page.screenshot({ path: 'board.png', fullPage: true });

await browser.close();
JS
(cd e2e && node scratch.mjs) && rm e2e/scratch.mjs
```

The working directory is `e2e/`, so `board.png` lands there — untracked, and easy to commit by
accident. Write it somewhere outside the repo if you are keeping it.

Ada is the one to sign in as for anything needing a permission: she is `OWNER`, and an owner holds
every staff permission implicitly. Her `CreatorStaff.permissions` array is empty in the database,
which looks wrong and is not — `permissions.ts` short-circuits on the role.

**Assert the state in the same run that captures it.** A screenshot proves nothing on its own, and
a caption written from memory drifts from the picture. Reading the thing you are about to
photograph — how many cards are nested, which buttons exist — keeps the two honest.

## What is stubbed

- **Patreon** — a local process at :4001. Real OAuth shape, real redirect, real state cookie; it
  simply approves whoever `/__be` last selected.
- **TMDB** — the same process. It knows about a handful of Studio Ghibli films, so catalogue
  search is thin: "Spirited Away" and "My Neighbor Totoro" resolve, most other things do not and
  come through as free text.
- **Embeddings** run locally on CPU. The first semantic search after a cold start pauses while the
  model loads (~120MB, downloaded once).

## Reset

```bash
docker compose -f docker-compose.demo.yml down -v && docker compose -f docker-compose.demo.yml up -d
```

The seed is idempotent, so re-running it against a live stack changes nothing — the way to get a
clean board is to drop the volume.
