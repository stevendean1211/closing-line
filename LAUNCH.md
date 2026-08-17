# Launch checklist

Ordered by dependency. Each step unblocks the next.

---

## 1. GitHub repo — do this first

Everything depends on it. It's the audit trail your whole pitch rests on, **and** Cloudflare
needs a connected repo to deploy the Functions (live cards, paywall).

```bash
cd <project folder>
git init
git add .
git commit -m "init"
```

Create a **public** repo on GitHub, then push. Public is not optional — a private repo means
"trust me," which is the thing you're selling against.

---

## 2. Cloudflare Pages

Dashboard → Workers & Pages → Create → **Connect to Git** → pick the repo.

- Build command: `node build.js`
- Output directory: `dist`

Direct upload won't work any more — `functions/` has to deploy alongside the site.

Confirm the `.pages.dev` URL renders styled and the cards page shows a real UFC card. If it does,
live odds are already working. No key needed.

---

## 3. Whop

You've made the business. Now:

- **Create the product** — one per tier. Free, Card Pass ($25 one-time), Monthly ($59 recurring),
  Season ($449/yr). Prices live in `data/tiers.json` too — keep them matched.
- **Install the delivery app** — Whop's own Sports app, or connect Discord. Look at Sports first;
  if it does the job, that's one less system.
- **Card Pass expiry** — one-time purchases don't expire by default. Set ~7 days of access, or
  your $25 buyers keep it forever.
- **Connect a bank account** — ACH, monthly payouts. Weekly burns $2.50 a time.
- **Store page** — this is your sales page on Discover. Not a product name and a dollar sign.
- **API key** — Developer settings. Goes in Cloudflare as `WHOP_API_KEY` (encrypted).

Optional at launch: the site's license-key gate. Discord/Sports delivery works without it.

---

## 4. Wire the links

```bash
node setup.js
```

Fills `data/site.json` with your Whop URL, Discord invite and repo URL, then offers to clear the
sample picks. Rerun any time.

---

## 5. First card

```bash
node fetch-card.js      # pull the live card
node log.js add         # log your picks — BEFORE the bell
git commit -am "add: <event> picks (n)"
git push                # this timestamp is the whole product
```

After the card:

```bash
node log.js grade       # closing lines + results
git commit -am "grade: <event>"
git push
```

Cloudflare rebuilds on push. That's the loop, forever.

---

## Before you charge anyone

`node build.js` prints what's missing. But the real gate isn't technical:

| Tier | Not until |
|---|---|
| Free | Day one |
| Card Pass | ~10 graded picks, positive CLV |
| Monthly | ~30 graded picks across 8+ cards |
| Season | 6 months of record |

Launch free-only. Let the record do the selling.
