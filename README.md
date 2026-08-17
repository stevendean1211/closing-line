# Verifiable UFC record + live odds board

Static site generated from a public, timestamped pick ledger. No framework, no database,
no dependencies. Node only.

```
data/picks/*.json        the ledger — this is the actual product
data/SCHEMA.md           field reference + the two-commit rule
data/odds-cache.json     generated, don't hand-edit
fetch-odds.js            pulls the upcoming card + prices
build.js                 math + static HTML
functions/api/odds.js    Cloudflare Function — live odds without leaking your key
.github/workflows/       scheduled refresh
dist/                    output — deploy this
```

## Rebrand

Top of `build.js`:

```js
const BRAND = 'CLOSING LINE';
const TAGLINE = '...';
const WHOP_URL = '#';
const DISCORD_URL = '#';
const REPO_URL = '#';
```

`CLOSING LINE` is a placeholder. Check the .com and the TikTok handle before committing to it.

## Daily loop

```bash
# before the card — log picks, closing_line and result stay null
git commit -am "add: UFC 321 picks (3)"

# after the card — fill in closing_line and result, nothing else
git commit -am "grade: UFC 321"

node fetch-odds.js && node build.js
```

Read `data/SCHEMA.md` before logging pick #1. The two-commit rule is what makes the record
auditable, and it's the one thing you can't retrofit.

---

## Live cards and odds — free, no key

Cards come from ESPN's public endpoints. **No API key, no signup, no quota, no monthly bill.**
These are the undocumented JSON endpoints espn.com itself runs on.

```
https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard
https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/{eventId}/competitions/{id}/odds
```

```bash
node fetch-card.js --verify    # confirm ESPN's shape hasn't drifted
node fetch-card.js && node build.js
```

### What ESPN gives you for nothing

Full bout order, both fighters with pro records, weight class, scheduled rounds, title-fight
flags, champion markers, venue, and a season calendar of every announced card. Verified against
a live response — the parser reconstructed a real 12-bout card, split correctly into Main Card /
Prelims / Early Prelims, with the main event identified.

**Card sections are derived, not configured.** Every bout in a block shares a start time, so the
distinct start times *are* the blocks — latest is the main card, earliest is early prelims. Three
blocks on a numbered card, two on most Fight Nights. There is no file to maintain.

Contender Series cards are filtered out of the calendar by default (`includeDWCS` in
`parseCalendar`).

### Odds are bound by identity, never position

This is the part that has to be right — a price shown against the wrong fighter is worse than
no price, because it looks authoritative and it's backwards.

Binding runs strictly in order of certainty and drops anything it can't resolve:

1. **Athlete id** — exact match against the competitor id from the card
2. **Name** — normalised for accents, apostrophes and non-decomposing characters (Błachowicz,
   O'Malley, Álvarez)
3. **Home/away slot** — only when the payload explicitly labels sides

Array position is never used. Arrays reorder; that is exactly how prices end up on the wrong man.

There's also a sanity gate: a real two-way market's implied probabilities sum to slightly over 1
(the vig). If the two buckets sum outside 0.95–1.35, they aren't opposite sides of the same
fight, so the bout renders "not yet priced" instead of showing something wrong.

`--verify` prints which method resolved the binding. If it ever says `home-away`, spot-check one
fight against a sportsbook — that's the only path with no identity check behind it.

Covered by 10 tests including: reversed source arrays, a third fighter's odds leaking into the
payload, one-sided markets, and impossible markets where both fighters are favourites.

### The one caveat

These endpoints are undocumented. ESPN publishes no rate limits, offers no SLA, and can change
the shape whenever they like — treat a break as a when, not an if. That's the actual price of
free. Two things soften it:

- `--verify` tells you in one command whether the contract still holds
- The Function edge-caches (`CARD_TTL`, default 300s) so you're not hammering someone else's
  infrastructure for free

If ESPN ever breaks and you want a paid fallback, The Odds API's `mma_mixed_martial_arts` key at
$29/mo is the drop-in. You don't need it today.

### Automatic card rollover

When a card finishes, it disappears and the next one takes its place. No manual step.

**Completion is decided by two independent signals, because neither alone is enough:**

- **ESPN status** — authoritative when it updates, but it lags. Observed live: ESPN reported UFC
  330 as `STATUS_IN_PROGRESS` with the main event still `STATUS_SCHEDULED` after the broadcast
  had ended.
- **Wall clock** — if the last scheduled bout was more than 6 hours ago, the card is over
  regardless of what ESPN thinks (`STALE_HOURS` in `espn.js`).

Either signal ends the card. Status-only would leave a dead card sitting on the site; clock-only
would drop a card that ran long.

Once finished, `nextCard()` walks the season calendar and promotes whatever comes next — numbered
PPV, Fight Night, Noche, Freedom, all the same path. Contender Series is skipped by default
(`includeDWCS`). The rollover runs in both the CLI fetcher and the edge Function, capped at 3
hops so a malformed calendar can't spin.

### Mid-card display

While a card is running, each bout renders its own state:

- **Finished** — winner marked, loser greyed, odds replaced by the result line
  (`Neil Magny def. Ramiz Brahimaj · KO/TKO · R2 3:20`), records already updated by ESPN
- **Live** — gold marker on the bout, pulsing dot in the card header
- **Scheduled** — normal odds display

Method comes from ESPN's `details[]`. Their label for a knockout is spelled "Kotko" — that is
their data, not a typo in the parser.

### Live behaviour

`/api/card` is the page's primary source and needs **zero configuration** — no env vars, no
secrets. Both pages fetch it on load, replace the statically-rendered card, re-poll every 2
minutes, and re-sync on tab refocus. The build-time cache exists only for first paint and
crawlers.

Announced-but-unpublished cards show with their real name and date and fill in as ESPN confirms
bouts. Unpriced bouts show "not yet priced" rather than disappearing.

### Cloudflare setup

Only the paywall needs secrets now:

- `WHOP_API_KEY` — the picks paywall
- `WHOP_PRODUCT_ID` — optional, if you sell more than one product
- `CARD_TTL` — optional, seconds, default 300

## The next automation, and it's the big one

Right now you record closing lines by hand. That's the most tedious part of the workflow and
the most likely reason you eventually stop logging.

A scheduled worker can snapshot odds a few minutes before each `commence_time` and write them
straight into the pick files. Two things happen: the boring part disappears, and closing lines
become **machine-captured rather than self-reported** — which makes the record strictly more
credible than a number you typed in yourself.

Everything needed is already here: `fetch-odds.js` gets prices, the schema has the field, the
Action has a schedule. It's a cron that matches fights to open picks and commits the result.
Worth building once real picks are flowing.

---

## Pricing tiers

All four live in `data/tiers.json` — name, price, cadence, feature list, CTA. Edit, rebuild,
done. They render on both `picks.html` and the home page. `url` accepts `"WHOP"` or `"DISCORD"`
as shorthand for the config constants in `build.js`, or a literal URL.

### Why a card pass exists

Monthly subscriptions are a poor fit for this sport and most cappers never notice. The UFC runs
about forty cards a year and they cluster — some months have five, some have two. A monthly
price charges the same for both, so in a thin month your subscribers feel robbed and churn, and
in a heavy month you're underpaid.

Per-card pricing tracks the actual product. It also lowers the barrier for someone who won't
commit $59 sight-unseen but will pay $25 for one card they were betting anyway — and a card pass
buyer who wins is the easiest monthly conversion you'll ever get.

### What the record has to justify

The prices in the config are placeholders. Don't ship them cold.

| Tier | Don't charge until |
|---|---|
| Free | Day one. This is the funnel and the proof. |
| Card Pass | ~10 graded picks with positive CLV. Low commitment, so a thin record is survivable. |
| Monthly | ~30 graded picks across 8+ cards. This is where people compare you to the $10 Discord. |
| Season | 6 months of public record. Nobody pays a year up front against three months of data. |

Charging monthly against a five-pick record is how a service dies in week three: someone asks
for the record, the honest answer is "small sample," and the honest answer is correct.

### Churn

Monthly churn in this category runs brutal — a bad week and people cancel. Two things help, both
already in the tiers: annual pricing removes eleven cancel decisions a year, and the card pass
gives someone a way to stay in your orbit without an active subscription to cancel.

---

## Deploy (Cloudflare Pages)

Upload the **contents** of `dist/` — not the folder. Dragging the folder nests everything and
breaks the links between pages. Zip the contents and let Cloudflare extract, or select the
files and drag them together. `index.html` at root.

For the live odds function you need a Git-connected Pages project rather than direct upload,
since `functions/` has to deploy alongside the site. Point Cloudflare at the repo, set the
build command to `node build.js`, output directory `dist`.

## Before you go live

Delete `data/picks/2026-07-11-ufc-318.json` and `data/picks/2026-08-22-ufc-319.json`, and clear
`data/odds-cache.json` — those are samples, and the odds in the cache are mock data used to
test the board.

The sample record is deliberately a losing stretch with strong CLV: −5.6% ROI, +8.8% average
CLV, 4 of 5 beating the close. That's the case the whole site exists to make — over five picks
the P/L is noise and the CLV is the only number carrying information. If the design tells that
story honestly during a cold run, it survives the cold runs.
