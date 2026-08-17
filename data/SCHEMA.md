# Pick schema

One JSON file per event, named `YYYY-MM-DD-slug.json`, in `data/picks/`.

```json
{
  "event": "UFC 321",
  "date": "2026-10-25",
  "picks": [
    {
      "id": "ufc321-01",
      "fight": "Aspinall vs Gane",
      "selection": "Tom Aspinall",
      "market": "moneyline",
      "line_taken": -145,
      "book": "DraftKings",
      "units": 1.5,
      "posted_at": "2026-10-24T18:03:00Z",
      "closing_line": null,
      "result": null,
      "note": "Short reasoning. Optional."
    }
  ]
}
```

## Field reference

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable, never reused. |
| `fight` | string | As billed. |
| `selection` | string | What you actually backed. |
| `market` | string | `moneyline`, `method`, `total`, `prop`, `parlay` |
| `line_taken` | int | American odds at the moment you posted. |
| `book` | string | Where the line was available. |
| `units` | float | Stake. 1u = your standard bet size. |
| `posted_at` | ISO 8601 | Display only — the git commit is the real timestamp. |
| `closing_line` | int \| null | American odds at close. Fill in **after** the event. |
| `result` | `"W"` \| `"L"` \| `"P"` \| null | `null` = pending. |
| `note` | string | Optional. |

## The two-commit rule

This is the part that makes the record worth anything. Every pick gets committed **twice**:

**Commit 1 — before the event.** `closing_line` and `result` are `null`. Commit message:
```
add: UFC 321 picks (3)
```

**Commit 2 — after the event.** Fill in `closing_line` and `result`. Nothing else changes. Commit message:
```
grade: UFC 321
```

The git history now proves the pick existed before the outcome was known. Anyone can run `git log --follow data/picks/2026-10-25-ufc-321.json` and check. That verifiability is the entire product — a record nobody can audit is worth exactly what every other tout's record is worth.

**Never amend, force-push, rebase, or delete a pick file.** If you make a genuine data-entry error, fix it in a new commit with a message explaining what was wrong. A visible correction is credible. A rewritten history is not — and it's detectable, which is worse.

## Getting the closing line

Record the line at the book you listed, as close to the opening bell as you can. Screenshot it and save to `data/evidence/{id}.png` if you want a second layer of proof. Free sources: the sportsbook itself, or an odds aggregator's line-history view.

---

## Premium picks

Live picks go in `data/premium/` using the same schema, minus `closing_line` and `result`,
plus a `released_at` timestamp. These are **never built into any HTML page** — `build.js`
compiles them into `functions/api/premium-data.js`, which only the Cloudflare Function reads.

After a card is graded, move the picks out of `data/premium/` and into `data/picks/` with the
closing lines and results filled in.

That lifecycle is the point: **the paywall gates timing, not information.** Subscribers get
picks before the bell; everyone sees them afterward. It also means the public record can never
be accused of hiding losers, because every premium pick eventually lands there.

### What the build guard can and can't verify

`build.js` fails the build if gated data reaches `dist/`. It checks pick ids, private notes,
raw pick-JSON field names, and whether the Function's data file escaped into the served
directory.

It deliberately does **not** search for selections or prices. A pick is a choice made from
public options — the selection is a fighter name and the price is the market price, both of
which correctly appear on the odds board. Searching for those only ever finds the board.

The security comes from selections never being written into a template in the first place, not
from the scan. The scan catches the case where that architecture breaks.
