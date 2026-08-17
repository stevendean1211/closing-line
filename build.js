#!/usr/bin/env node
/**
 * Static site generator — 5 pages, live odds, gated picks.
 *
 *   dist/index.html    hero + tale of the tape + next card
 *   dist/odds.html     every upcoming card, live-syncing
 *   dist/picks.html    paywalled — teaser only; real picks come from /api/picks
 *   dist/record.html   full public ledger
 *   dist/method.html   the CLV argument
 *
 * Also writes functions/api/premium-data.js so the Function can serve gated
 * picks. That file is deliberately never written into dist/.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
const SITE = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'site.json'), 'utf8')); }
  catch { return {}; }
})();

const BRAND = SITE.brand || 'CLOSING LINE';
const TAGLINE = SITE.tagline || 'Every UFC pick, timestamped before the bell and graded against the close.';
const WHOP_URL = SITE.whop_url || '#';
const DISCORD_URL = SITE.discord_url || '';
const FREE_URL = SITE.free_url || SITE.whop_url || '#';
const REPO_URL = SITE.repo_url || '#';
const PRICE = SITE.price || '$59/mo';

const DIR = { picks: 'data/picks', premium: 'data/premium', out: 'dist' };
const P = (...a) => path.join(__dirname, ...a);

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------
const toDec = (a) => (a == null ? null : a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
const clvPct = (t, c) => (toDec(t) === null || toDec(c) === null ? null : (toDec(t) / toDec(c) - 1) * 100);
const unitsPL = (p) => p.result === 'W'
  ? (p.line_taken > 0 ? p.units * (p.line_taken / 100) : p.units * (100 / Math.abs(p.line_taken)))
  : p.result === 'L' ? -p.units : 0;

const odds = (o) => (o == null ? '—' : o > 0 ? `+${o}` : `${o}`);
const units = (u) => `${u >= 0 ? '+' : '−'}${Math.abs(u).toFixed(2)}u`;
const pct = (p, d = 1) => (p === null ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(d)}%`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
const readJSON = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

function loadDir(dir) {
  const full = P(dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function aggregate(events) {
  const all = events.flatMap((e) => e.picks.map((p) => ({ ...p, event: e.event })));
  const graded = all.filter((p) => p.result);
  const clvs = all.filter((p) => p.closing_line != null).map((p) => clvPct(p.line_taken, p.closing_line));
  const w = graded.filter((p) => p.result === 'W').length;
  const l = graded.filter((p) => p.result === 'L').length;
  const pu = graded.filter((p) => p.result === 'P').length;
  const staked = graded.reduce((s, p) => s + p.units, 0);
  const pl = graded.reduce((s, p) => s + unitsPL(p), 0);
  const beat = clvs.filter((c) => c > 0).length;
  return {
    all, w, l, pu, staked, pl, clvs, beat, lost: clvs.length - beat, n: clvs.length,
    roi: staked > 0 ? (pl / staked) * 100 : null,
    avgClv: clvs.length ? clvs.reduce((x, y) => x + y, 0) / clvs.length : null,
    beatRate: clvs.length ? (beat / clvs.length) * 100 : null,
    pending: all.filter((p) => !p.result).length,
    events: events.length,
    since: events.length ? events[events.length - 1].date : null,
  };
}

/**
 * Cards arrive pre-structured from fetch-card.js / the Function: real event
 * name, venue, bout order, card section, weight class. No local grouping, no
 * hand-maintained override file.
 */
const asCards = (cache) => (cache && Array.isArray(cache.cards) ? cache.cards : []);

// ---------------------------------------------------------------------------
function scorecard(clvs, avg) {
  if (!clvs.length) return '';
  const W = 1000, H = 150, pad = 20, axis = H - 46;
  const b = Math.max(12, Math.ceil(Math.max(...clvs.map(Math.abs), 8) / 4) * 4);
  const x = (v) => pad + ((Math.max(-b, Math.min(b, v)) + b) / (2 * b)) * (W - pad * 2);
  const grid = [-b, -b / 2, 0, b / 2, b].map((v) => {
    const z = v === 0;
    return `<line x1="${x(v).toFixed(1)}" y1="16" x2="${x(v).toFixed(1)}" y2="${axis}" stroke="${z ? 'var(--bone)' : 'var(--line)'}" stroke-width="${z ? 2 : 1}" ${z ? '' : 'stroke-dasharray="2 5"'}/><text x="${x(v).toFixed(1)}" y="${axis + 24}" class="ax" text-anchor="middle">${v > 0 ? '+' : ''}${v}%</text>`;
  }).join('');
  const marks = clvs.map((v) => `<line x1="${x(v).toFixed(1)}" y1="28" x2="${x(v).toFixed(1)}" y2="${axis - 7}" stroke="${v > 0 ? 'var(--blue)' : 'var(--red)'}" stroke-width="3" stroke-linecap="round" opacity=".8"/>`).join('');
  const mean = avg === null ? '' : `<polygon points="${x(avg).toFixed(1)},13 ${(x(avg) - 7).toFixed(1)},0 ${(x(avg) + 7).toFixed(1)},0" fill="var(--gold)"/><text x="${x(avg).toFixed(1)}" y="${axis + 41}" class="ax gold" text-anchor="middle">MEAN ${pct(avg)}</text>`;
  return `<svg class="card-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="CLV across ${clvs.length} graded picks, mean ${pct(avg)}">${grid}${marks}${mean}</svg>`;
}

const CSS = fs.readFileSync(P('style.css'), 'utf8');

function layout({ title, desc, body, active, script = '', compact = false }) {
  const nav = [['Odds', 'odds.html'], ['Picks', 'picks.html'], ['Record', 'record.html'], ['Method', 'method.html']];
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc || TAGLINE)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc || TAGLINE)}">
<meta property="og:type" content="website"><meta name="theme-color" content="#0D0C0B">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body${compact ? ' data-compact="1"' : ''}>
<header class="site"><div class="wrap">
<a class="brand" href="index.html"><i></i>${esc(BRAND)}</a>
<nav class="site">${nav.map(([l, h]) => `<a href="${h}"${l === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}<a href="${REPO_URL}" class="verify">Verify</a></nav>
</div></header>
${body}
<footer class="site"><div class="wrap">
<div class="warn"><strong>21+ only.</strong> Picks are opinion and analysis, published for entertainment.
Nothing here is financial advice and no outcome is guaranteed. Bet only what you can afford to lose.
If gambling stops being fun: <a href="tel:18004262537">1-800-GAMBLER</a>, or the Connecticut Council on
Problem Gambling at <a href="tel:18003463238">1-800-346-6238</a>.</div>
<p>© ${new Date().getFullYear()} ${esc(BRAND)} · built ${new Date().toISOString().slice(0, 10)} ·
<a href="${REPO_URL}">audit the data</a></p></div></footer>${script}</body></html>`;
}

// ---------------------------------------------------------------------------
const tape = (a) => !a.n ? '' : `<div class="tape">
<div class="tape-head">
  <div class="corner a"><div class="tag">Red corner</div><div class="nm">${esc(BRAND)}</div></div>
  <div class="vs">VS</div>
  <div class="corner b"><div class="tag">Blue corner</div><div class="nm">The market</div></div>
</div>
${[['Rounds won', a.beat, a.lost, 1], ['Win rate', `${a.beatRate.toFixed(0)}%`, `${(100 - a.beatRate).toFixed(0)}%`, 0], ['Graded picks', a.n, a.n, 0]]
  .map(([l, x, y, w]) => `<div class="tape-row${w ? ' win' : ''}"><div class="v a">${x}</div><div class="lab">${l}</div><div class="v b">${y}</div></div>`).join('')}
<div class="tape-foot"><div class="k">Decision · average closing line value</div><div class="big">${pct(a.avgClv)}</div></div>
</div>`;

const stats = (a) => {
  const c = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  return `<div class="stats">${[
    ['Avg CLV', pct(a.avgClv), `${a.n} graded`, c(a.avgClv)],
    ['Beat the close', a.beatRate === null ? '—' : `${a.beatRate.toFixed(0)}%`, `${a.beat} of ${a.n}`, ''],
    ['Units', units(a.pl), `${a.staked.toFixed(1)}u risked`, c(a.pl)],
    ['ROI', pct(a.roi), `${a.w}–${a.l}${a.pu ? '–' + a.pu : ''}`, c(a.roi)],
  ].map(([k, v, s, cl]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cl}">${v}</div><div class="s">${s}</div></div>`).join('')}</div>`;
};

function priceCell(x, side, priced) {
  if (!priced) return `<div class="o ${side}"><span class="dash">—</span><small>no line</small></div>`;
  return `<div class="o ${side}">${odds(x.best)}
    <small>${esc(x.book || '')}</small>
    <em>${x.implied != null ? x.implied + '%' : ''}</em></div>`;
}

function boutRow(f) {
  const done = f.state === 'post';
  const live = f.state === 'in';
  const priced = f.priced === true && f.a.best != null && !done;
  const nm = (x) => `<span class="who${x.won ? ' won' : done ? ' lost' : ''}">${esc(x.name)}` +
    `${x.champion ? '<span class="belt" title="Champion">★</span>' : ''}` +
    `${x.won ? '<span class="wtag">W</span>' : ''}</span>` +
    (x.record ? `<span class="rec">${esc(x.record)}</span>` : '');

  return `<div class="bout${f.isMain ? ' main' : ''}${done ? ' done' : ''}${live ? ' live' : ''}">
  <div class="bout-meta">
    <span class="bno">Bout ${f.bout}</span>
    ${f.weight ? `<span class="wt">${esc(f.weight)}</span>` : ''}
    ${f.titleFight ? '<span class="ttl">Title</span>' : ''}
    ${f.isMain ? '<span class="me">Main event</span>' : ''}
    ${live ? '<span class="livetag">Live</span>' : ''}
    <span class="rds">${done ? 'Final' : `${f.rounds || 3} rds`}</span>
  </div>
  <div class="bout-line">
    <div class="f a">${nm(f.a)}</div>
    ${done ? '<div class="o res a"></div>' : priceCell(f.a, 'a', priced)}
    <div class="vsx">vs</div>
    ${done ? '<div class="o res b"></div>' : priceCell(f.b, 'b', priced)}
    <div class="f b">${nm(f.b)}</div>
  </div>
  ${done
    ? `<div class="bout-foot"><span class="result">${f.winnerName ? `${esc(f.winnerName)} def. ${esc(f.winnerId === f.a.id ? f.b.name : f.a.name)}` : 'Result pending'}${f.method ? ` &middot; ${esc(f.method)}` : ''}${f.endedAt ? ` &middot; ${esc(f.endedAt)}` : ''}</span></div>`
    : priced
      ? `<div class="bout-foot"><span>fair <b>${odds(f.a.fair)}</b> / <b>${odds(f.b.fair)}</b></span>
         <span>${f.hold}% hold</span><span>${f.books} book${f.books === 1 ? '' : 's'}</span></div>`
      : '<div class="bout-foot"><span>not yet priced</span></div>'}
</div>`;
}

function cardBlock(card, opts = {}) {
  const head = `<div class="fc-head">
    <div><div class="fc-name">${esc(card.name)}</div>
      <div class="fc-sub">${card.date ? new Date(card.date + 'T12:00:00Z').toUTCString().slice(0, 16) : ''}${card.venue ? ` · ${esc(card.venue)}` : ''}</div></div>
    <div class="fc-count">${card.announced ? 'Announced'
      : card.state === 'live' ? '<span class="livedot"></span>Live now'
      : card.state === 'final' ? 'Final'
      : `${card.pricedCount}/${card.count} priced`}</div>
  </div>`;

  if (card.announced || !card.sections.length) {
    return `<div class="fightcard announced">${head}
      <div class="board-empty">Card not published yet — bouts appear here as ESPN confirms them.</div></div>`;
  }
  const sections = opts.compact ? card.sections.slice(0, 1) : card.sections;
  return `<div class="fightcard">${head}
  ${sections.map((sec) => `<div class="fc-sec">
    <div class="fc-sec-label">${esc(sec.label)}</div>
    ${sec.fights.map(boutRow).join('')}
  </div>`).join('')}
  ${opts.compact && card.sections.length > 1 ? `<div class="fc-more"><a href="odds.html">Full card — prelims and every line →</a></div>` : ''}
</div>`;
}

function tierGrid(cfg) {
  const t = cfg.tiers || [];
  if (!t.length) return '';
  const link = (u) => (u === 'WHOP' ? WHOP_URL : u === 'DISCORD' ? DISCORD_URL : u);
  return `<div class="tiers">${t.map((x) => `<div class="tier${x.featured ? ' featured' : ''}">
    ${x.featured ? '<div class="tier-flag">Most popular</div>' : ''}
    <div class="tier-name">${esc(x.name)}</div>
    <div class="tier-price"><span class="cur">${esc(cfg.currency || '$')}</span>${esc(x.price)}
      <small>${esc(x.cadence)}</small></div>
    <div class="tier-tag">${esc(x.tagline)}</div>
    <ul class="tier-feats">${(x.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    <a class="btn${x.featured ? '' : ' ghost'}" href="${link(x.url)}">${esc(x.cta)}</a>
  </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const pageIndex = (a, cards, tiers) => layout({
  title: `${BRAND} — UFC picks, graded in public`, active: 'Home', script: LIVE_CARD_JS, compact: true,
  body: `<main class="wrap">
<div class="hero">
  <div class="eyebrow">${a.events} card${a.events === 1 ? '' : 's'}${a.since ? ` · since ${a.since}` : ''} · nothing deleted</div>
  <h1>I bet the<br>fights.<br><span class="out">You check<br>the log.</span></h1>
  <p class="lede">Every pick goes into a public repository before the walkouts, with the price and the
  stake. After the card it's graded against the closing line. The commit history is the receipt.</p>
  <div class="btns"><a class="btn" href="picks.html">This week's picks</a>
    <a class="btn ghost" href="record.html">Full record</a></div>
  ${tape(a)}
</div>
<section><h2>Next up</h2>
  <div id="cards">${cards[0] ? cardBlock(cards[0], { compact: true }) : '<div class="fightcard"><div class="board-empty" id="loading">Loading the next card…</div></div>'}</div>
  <div class="btns"><a class="btn ghost" href="odds.html">All upcoming cards</a></div></section>
<section><h2>Packages</h2>
  <p class="prose">One free play on every card, or take the whole card. Everything gets graded
  the same and everything lands on the public record afterwards.</p>
  ${tierGrid(tiers)}</section>
<section><div class="audit"><h2>Don't trust me. Check.</h2>
  <p class="prose">Other services ask you to trust their platform's verification. This one asks you to
  trust nothing — clone the repo and read the history. A backdated pick or a quietly removed loss
  would show up in the log.</p><code>git log --follow --date=iso data/picks/</code></div></section>
</main>`,
});

const pageOdds = (cards, cache) => layout({
  title: `Upcoming cards — ${BRAND}`, active: 'Odds',
  desc: 'Live UFC fight cards and odds across books, with the vig stripped out.',
  body: `<main class="wrap">
<div class="hero short">
  <div class="eyebrow"><span id="stamp">${cache.fetched_at ? `updated ${new Date(cache.fetched_at).toISOString().slice(11, 16)}Z` : 'Loading…'}</span></div>
  <h1>Upcoming<br>cards</h1>
  <p class="lede">Every confirmed bout on every announced card — main card, prelims, early prelims,
  in fight order. Best available number on each side and the no-vig fair line underneath.</p>
</div>
<section id="cards" aria-live="polite">${
  cards.length ? cards.map((c) => cardBlock(c)).join('')
  : cache.configured === false
    ? `<div class="fightcard"><div class="board-empty">Loading cards from ESPN…</div></div>`
    : `<div class="fightcard"><div class="board-empty" id="loading">Loading cards…</div></div>`
}</section>
<section><div class="prose"><h2>Reading the board</h2>
  <p><b>Best</b> is the highest price available on that side and where to get it. If your book isn't
  showing it, you're paying for the privilege of not shopping.</p>
  <p><b>Fair</b> is the consensus line with the vig removed — the closest thing to the market's honest
  opinion, and the number to compare a pick against.</p>
  <p><b>Hold</b> is the books' margin on that fight. Usually 3–5% in MMA, wider on prelims.</p></div></section>
</main>`,
  script: LIVE_CARD_JS,
});

function pagePicks(premium, a, tiers) {
  const total = premium.reduce((s, c) => s + c.picks.length, 0);
  const teaser = premium.map((c) => `<div class="lock-card">
    <div class="lock-head"><div class="ev">${esc(c.event)}</div>
      <div class="stamp">${c.picks.length} pick${c.picks.length === 1 ? '' : 's'} · released ${c.released_at ? new Date(c.released_at).toUTCString().slice(0, 16) : '—'}</div></div>
    ${c.picks.map(() => `<div class="lock-row"><span class="blur">████████████████</span><span class="blur sm">████</span><span class="blur sm">███</span></div>`).join('')}
  </div>`).join('');

  return layout({
    title: `Picks — ${BRAND}`, active: 'Picks',
    desc: 'Members-only UFC picks, released before the card.',
    body: `<main class="wrap">
<div class="hero short">
  <div class="eyebrow">Members · released before the walkouts</div>
  <h1>The picks</h1>
  <p class="lede">Selections, prices and stakes go out before the card. After it's graded, every one
  of them moves to the public record — losers included. You're paying for the timing, not for
  information I keep buried.</p>
</div>
<section id="packages">
  <h2>Packages</h2>
  <p class="prose">Everything is graded the same way and everything lands on the
  <a href="record.html">public record</a> after the card. What you're buying is the timing and
  the depth, not access to a secret.</p>
  ${tierGrid(tiers)}
  <p class="prose sm">The UFC runs about forty cards a year and they cluster — some months have
  five, some have two. That's why the card pass exists: a month with one card you care about
  shouldn't cost the same as a month with five.</p>
</section>

<section>
  <div id="gate">
    <div class="gate">
      <div class="gate-head"><h2>Enter your key</h2>
        <p class="prose">Your Whop license key unlocks this page. Members get it at checkout.</p></div>
      <div class="gate-form">
        <label class="sr" for="key">License key</label>
        <input id="key" type="text" placeholder="Paste your license key" autocomplete="off" spellcheck="false">
        <button class="btn" id="unlock">Unlock</button>
      </div>
      <div id="err" class="gate-err" hidden></div>
      <p class="gate-alt">No key yet? <a href="#packages">See the packages</a> · <a href="${FREE_URL}">Get the free play</a></p>
    </div>
    ${premium.length ? `<div class="locked">${teaser}
      <p class="prose sm">${total} pick${total === 1 ? '' : 's'} currently live behind the key. The
      selections are not present in this page's source — they're served only after a key checks out.</p></div>`
      : '<p class="prose">Nothing live right now. Next card gets posted before the walkouts.</p>'}
  </div>
  <div id="unlocked" hidden></div>
</section>
<section><div class="prose"><h2>What you get</h2>
  <p>Selection, the exact price I took, which book, and the stake in units. No parlays sold as locks,
  no five-star play of the year. If a card has nothing worth betting, you get a card with nothing on it.</p>
  <p>Everything here lands on the <a href="record.html">public record</a> after grading. That's the
  deal — the paywall buys you time, and the record stays honest because I can't quietly drop the ones
  that lost.</p></div>${stats(a)}</section>
</main>`,
    script: GATE_JS,
  });
}

const pageRecord = (events, a) => layout({
  title: `Record — ${BRAND}`, active: 'Record',
  desc: 'Complete public record of every UFC pick, graded against the closing line.',
  body: `<main class="wrap">
<div class="hero short">
  <div class="eyebrow">Complete ledger · ${a.pending} live</div><h1>The record</h1>
  <p class="lede">Every pick ever posted, in order, including the losers and the ones where the market
  moved against me. Free picks are graded exactly the same as paid ones.</p>
</div>
<section>${scorecard(a.clvs, a.avgClv)}
  <div class="key"><span><i style="background:var(--blue)"></i>Beat the close</span>
  <span><i style="background:var(--red)"></i>Missed it</span>
  <span><i style="background:var(--gold)"></i>Mean</span><span>One mark per graded pick</span></div>
  ${stats(a)}</section>
<section>${events.map((e) => {
    const pl = e.picks.reduce((s, p) => s + unitsPL(p), 0);
    return `<div class="ev-head"><h3>${esc(e.event)}</h3>
  <div class="meta">${e.date} · ${e.picks.length} pick${e.picks.length === 1 ? '' : 's'} · ${units(pl)}</div></div>
  <table><thead><tr><th>Selection</th><th class="num">Taken</th><th>Book</th><th class="num">Stake</th>
  <th class="num">Close</th><th class="num">CLV</th><th class="num">Res</th><th class="num">P/L</th></tr></thead>
  <tbody>${e.picks.map((p) => {
      const c = clvPct(p.line_taken, p.closing_line);
      return `<tr><td><span class="sel">${esc(p.selection)}</span><span class="fx">${esc(p.fight)} · ${esc(p.market)}</span></td>
    <td class="num">${odds(p.line_taken)}</td><td>${esc(p.book)}</td><td class="num">${p.units.toFixed(1)}u</td>
    <td class="num">${odds(p.closing_line)}</td>
    <td class="num ${c === null ? '' : c > 0 ? 'clv pos' : 'clv neg'}">${pct(c)}</td>
    <td class="num">${p.result ? `<span class="res ${p.result}">${p.result}</span>` : '<span class="pend">Live</span>'}</td>
    <td class="num">${p.result ? units(unitsPL(p)) : '—'}</td></tr>`;
    }).join('')}</tbody></table>`;
  }).join('') || '<p class="prose">No picks logged yet.</p>'}</section>
<section><div class="audit"><h2>Verify this page</h2>
  <p class="prose">Every row is generated from JSON in a public repo. Each pick is committed once
  before the card with price and stake, then again after to add the closing line and result. Compare
  the commit dates to the event dates.</p>
  <code>git log --follow --date=iso data/picks/</code></div></section>
</main>`,
});

const pageMethod = (a) => layout({
  title: `Method — ${BRAND}`, active: 'Method',
  desc: 'Why closing line value is the number that matters and win rate is the footnote.',
  body: `<main class="wrap">
<div class="hero short"><div class="eyebrow">How this is graded</div><h1>CLV over<br>win rate</h1></div>
<section><div class="prose">
  <p>The UFC runs about forty cards a year. Over a sample that small a win-loss record tells you
  almost nothing — a good month sits comfortably inside the range of pure luck, which is exactly why
  every capper on the internet can show you one.</p>
  <p>Closing line value is harder to fake. Take a fighter at +145, watch the market close him at +118,
  and you bought a price better than the one the entire betting market eventually agreed on. Do that
  consistently and you have an edge. Fail to do it and no hot streak will save you, because closing
  lines are public, permanent, and not mine to edit.</p>
  <p>So CLV is the headline here and win rate is the footnote. That's backwards from how this is
  normally sold, and it means a losing month with good numbers still tells you the truth.</p></div>
<div class="grid3">
  <div class="card"><h3>Posted before</h3><p>Selection, price, book and stake committed before the opening bell. Never after.</p></div>
  <div class="card"><h3>Graded after</h3><p>A second commit adds the closing line and result. Nothing else gets touched.</p></div>
  <div class="card"><h3>Losers stay up</h3><p>Nothing is removed, ever. A record with no bad beats in it is a record someone edited.</p></div>
</div></section>
<section><h2>The current numbers</h2>${stats(a)}${scorecard(a.clvs, a.avgClv)}
  <div class="key"><span><i style="background:var(--blue)"></i>Beat the close</span>
  <span><i style="background:var(--red)"></i>Missed it</span><span><i style="background:var(--gold)"></i>Mean</span></div></section>
<section><div class="prose"><h2>What I don't do</h2>
  <p>No guaranteed plays. No lock of the month. No record that starts the day I got hot. If a card is
  unbettable you'll get a card with nothing on it, which is a worse business model and a better
  service.</p></div></section>
</main>`,
});

// ---------------------------------------------------------------------------
const LIVE_CARD_JS = `<script>
(function(){
  var o=function(n){return n==null?'—':(n>0?'+'+n:''+n)};
  var E=function(s){return String(s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
  var compact=document.body.getAttribute('data-compact')==='1';

  function nm(x,done){ return '<span class="who'+(x.won?' won':(done?' lost':''))+'">'+E(x.name)+
    (x.champion?'<span class="belt">★</span>':'')+(x.won?'<span class="wtag">W</span>':'')+'</span>'+
    (x.record?'<span class="rec">'+E(x.record)+'</span>':''); }
  function cell(x,side,priced){
    if(!priced) return '<div class="o '+side+'"><span class="dash">—</span><small>no line</small></div>';
    return '<div class="o '+side+'">'+o(x.best)+'<small>'+E(x.book||'')+'</small>'+
      '<em>'+(x.implied!=null?x.implied+'%':'')+'</em></div>';
  }
  function bout(f){
    var done=f.state==='post', live=f.state==='in';
    var priced = f.priced===true && f.a.best!=null && !done;
    var foot;
    if(done){
      var loser = f.winnerId===f.a.id ? f.b.name : f.a.name;
      foot='<div class="bout-foot"><span class="result">'+
        (f.winnerName?E(f.winnerName)+' def. '+E(loser):'Result pending')+
        (f.method?' · '+E(f.method):'')+(f.endedAt?' · '+E(f.endedAt):'')+'</span></div>';
    } else if(priced){
      foot='<div class="bout-foot"><span>fair <b>'+o(f.a.fair)+'</b> / <b>'+o(f.b.fair)+
        '</b></span><span>'+f.hold+'% hold</span><span>'+f.books+' book'+(f.books===1?'':'s')+'</span></div>';
    } else foot='<div class="bout-foot"><span>not yet priced</span></div>';
    return '<div class="bout'+(f.isMain?' main':'')+(done?' done':'')+(live?' live':'')+'">'+
      '<div class="bout-meta"><span class="bno">Bout '+f.bout+'</span>'+
      (f.weight?'<span class="wt">'+E(f.weight)+'</span>':'')+
      (f.titleFight?'<span class="ttl">Title</span>':'')+
      (f.isMain?'<span class="me">Main event</span>':'')+
      (live?'<span class="livetag">Live</span>':'')+
      '<span class="rds">'+(done?'Final':(f.rounds||3)+' rds')+'</span></div>'+
      '<div class="bout-line"><div class="f a">'+nm(f.a,done)+'</div>'+
      (done?'<div class="o res a"></div>':cell(f.a,'a',priced))+'<div class="vsx">vs</div>'+
      (done?'<div class="o res b"></div>':cell(f.b,'b',priced))+
      '<div class="f b">'+nm(f.b,done)+'</div></div>'+foot+'</div>';
  }
  function card(c){
    var head='<div class="fc-head"><div>'+
      '<div class="fc-name">'+E(c.name)+'</div><div class="fc-sub">'+
      (c.date?new Date(c.date+'T12:00:00Z').toUTCString().slice(0,16):'')+
      (c.venue?' · '+E(c.venue):'')+'</div></div>'+
      '<div class="fc-count">'+(c.announced?'Announced':
        c.state==='live'?'<span class="livedot"></span>Live now':
        c.state==='final'?'Final':c.pricedCount+'/'+c.count+' priced')+'</div></div>';
    if(c.announced || !c.sections.length)
      return '<div class="fightcard announced">'+head+
        '<div class="board-empty">Card not published yet — bouts appear here as ESPN confirms them.</div></div>';
    var secs = compact ? c.sections.slice(0,1) : c.sections;
    return '<div class="fightcard">'+head+
      secs.map(function(s){
        return '<div class="fc-sec"><div class="fc-sec-label">'+E(s.label)+'</div>'+
          s.fights.map(bout).join('')+'</div>';
      }).join('')+
      (compact && c.sections.length>1
        ? '<div class="fc-more"><a href="odds.html">Full card — prelims and every line →</a></div>' : '')+
      '</div>';
  }
  function stamp(t){ var el=document.getElementById('stamp'); if(el) el.textContent=t; }

  async function sync(){
    try{
      var r=await fetch('/api/card',{cache:'no-store'});
      if(!r.ok) return;
      var d=await r.json();
      var el=document.getElementById('cards');
      if(!el) return;
      if(!d.cards || !d.cards.length){
        stamp(d.fetched_at?'updated '+new Date(d.fetched_at).toISOString().slice(11,16)+'Z':'no cards');
        el.innerHTML='<div class="fightcard"><div class="board-empty">No confirmed cards announced right now.</div></div>';
        return;
      }
      el.innerHTML=(compact?d.cards.slice(0,1):d.cards).map(card).join('');
      stamp('updated '+new Date(d.fetched_at).toISOString().slice(11,16)+'Z');
    }catch(e){
      var l=document.getElementById('loading');
      if(l) l.textContent='Could not load cards. Retrying…';
    }
  }
  sync();
  setInterval(sync,120000);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) sync(); });
})();
</script>` ;

const GATE_JS = `<script>
(function(){
  var KEY='cl_license';
  var input=document.getElementById('key'), btn=document.getElementById('unlock'),
      err=document.getElementById('err'), gate=document.getElementById('gate'),
      out=document.getElementById('unlocked');
  if(!btn)return;
  function store(v){ try{ v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY); }catch(e){} }
  function stored(){ try{ return localStorage.getItem(KEY); }catch(e){ return null; } }
  function reset(){ btn.disabled=false; btn.textContent='Unlock'; }
  function fail(m){ err.textContent=m; err.hidden=false; reset(); }
  var o=function(n){return n==null?'—':(n>0?'+'+n:''+n)};
  var E=function(s){return String(s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};

  function render(d){
    gate.hidden=true; out.hidden=false;
    if(!d.cards||!d.cards.length){ out.innerHTML='<p class="prose">Unlocked — no picks live right now.</p>'; return; }
    out.innerHTML='<div class="unlocked-bar"><span>Unlocked'+
      (d.expires_at?' · renews '+new Date(d.expires_at*1000).toUTCString().slice(5,16):'')+
      '</span><button id="lock" class="linkbtn">sign out</button></div>'+
      d.cards.map(function(c){
        return '<div class="board"><div class="board-head"><div class="ev">'+E(c.event)+'</div>'+
        '<div class="stamp">'+c.picks.length+' pick'+(c.picks.length===1?'':'s')+'</div></div>'+
        c.picks.map(function(p){
          return '<div class="pick"><div class="p-sel">'+E(p.selection)+
          '<span class="fx">'+E(p.fight)+' · '+E(p.market)+'</span></div>'+
          '<div class="p-num">'+o(p.line_taken)+'<small>'+E(p.book)+'</small></div>'+
          '<div class="p-num">'+p.units.toFixed(1)+'u<small>stake</small></div>'+
          (p.note?'<div class="p-note">'+E(p.note)+'</div>':'')+'</div>';
        }).join('')+'</div>';
      }).join('');
    var lock=document.getElementById('lock');
    if(lock)lock.onclick=function(){ store(null); location.reload(); };
  }

  async function unlock(k,quiet){
    if(!k)return fail('Enter your license key.');
    btn.disabled=true; btn.textContent='Checking…'; err.hidden=true;
    try{
      var r=await fetch('/api/picks',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:k})});
      var d=await r.json();
      if(!r.ok){ store(null); if(quiet){reset();return;} return fail(d.error||'That key did not work.'); }
      store(k); render(d);
    }catch(e){ fail('Could not reach the server. Try again.'); }
  }
  btn.onclick=function(){ unlock(input.value.trim()); };
  input.addEventListener('keydown',function(e){ if(e.key==='Enter') btn.click(); });
  var saved=stored(); if(saved){ input.value=saved; unlock(saved,true); }
})();
</script>`;

// ---------------------------------------------------------------------------
function main() {
  const events = loadDir(DIR.picks);
  const premium = loadDir(DIR.premium);
  const a = aggregate(events);
    const cache = readJSON(P('data/card-cache.json'), { cards: [], fetched_at: null, configured: false });
  const tiers = readJSON(P('data/tiers.json'), { currency: '$', tiers: [] });
  const cards = asCards(cache);

  fs.mkdirSync(P(DIR.out), { recursive: true });
  const write = (f, html) => fs.writeFileSync(P(DIR.out, f), html);
  write('index.html', pageIndex(a, cards, tiers));
  write('odds.html', pageOdds(cards, cache));
  write('picks.html', pagePicks(premium, a, tiers));
  write('record.html', pageRecord(events, a));
  write('method.html', pageMethod(a));

  // The Function gets a generated ESM copy of the ESPN parser — one source of
  // truth, so the CLI and the edge can never disagree about card shape.
  const lib = fs.readFileSync(P('espn.js'), 'utf8')
    .replace(/^module\.exports = .*$/m, 'export { SCOREBOARD, CORE, parseCard, parseCalendar, parseOdds, sectionsByTime };');
  fs.writeFileSync(P('functions/api/espn-lib.js'), `// GENERATED from espn.js by build.js — do not edit.\n${lib}`);

  // Premium picks go to the Function bundle, never to dist/.
  fs.writeFileSync(P('functions/api/premium-data.js'),
    `// GENERATED by build.js — do not edit. Never served as a static asset.\nexport default ${JSON.stringify(premium, null, 2)};\n`);

  // Guard: fail the build loudly if gated data reaches the bundle.
  //
  // Note on what this can and can't check. You cannot detect a leaked *pick* by
  // string-matching, because a pick is a choice made from public options: the
  // selection is a fighter name and the price is the market price, both of which
  // legitimately appear on the odds board. Searching for them only ever finds
  // the board.
  //
  // So the guard is structural. Security comes from selections never being
  // rendered into a template at all; this checks the things that would only
  // exist in the bundle if that architecture had broken — internal ids, private
  // notes, raw pick-JSON field names, and the Function's data file escaping
  // into the served directory.
  const files = fs.readdirSync(P(DIR.out));
  const bundle = files.filter((f) => f.endsWith('.html'))
    .map((f) => fs.readFileSync(P(DIR.out, f), 'utf8')).join('');

  const problems = [];
  for (const c of premium) {
    for (const p of c.picks) {
      if (bundle.includes(p.id)) problems.push(`pick id "${p.id}"`);
      if (p.note && bundle.includes(p.note)) problems.push(`note on "${p.id}"`);
    }
  }
  for (const field of ['line_taken', 'posted_at', 'released_at']) {
    if (bundle.includes(`"${field}"`)) problems.push(`raw pick JSON field "${field}"`);
  }
  if (files.some((f) => f.includes('premium'))) problems.push('premium data file in dist/');

  if (problems.length) {
    console.error('\n  LEAK — gated data found in the served bundle:');
    problems.forEach((p) => console.error(`    ${p}`));
    console.error('');
    process.exit(1);
  }

  // Readiness check — what still stands between this and a live site.
  const todo = [];
  if (!SITE.whop_url) todo.push('whop_url      — checkout link, from your Whop product page');
  if (!SITE.repo_url) todo.push('repo_url      — public GitHub repo; the "check the log" link');
  if (!events.length) todo.push('picks         — no graded picks yet: node log.js add');
  if (!cards.length) todo.push('cards         — no card cached: node fetch-card.js');

  console.log('Built 5 pages');
  console.log(`  Public     ${a.events} cards / ${a.all.length} picks · ${a.w}-${a.l}${a.pu ? '-' + a.pu : ''}`);
  console.log(`  Units      ${units(a.pl)} on ${a.staked.toFixed(1)}u · ROI ${pct(a.roi)}`);
  console.log(`  Avg CLV    ${pct(a.avgClv)} over ${a.n} · tape ${a.beat}-${a.lost}`);
  console.log(`  Premium    ${premium.length} card(s) / ${premium.reduce((s, c) => s + c.picks.length, 0)} picks — gated, no leak`);
  if (todo.length) {
    console.log(`\n  NOT READY TO LAUNCH — ${todo.length} item(s):`);
    todo.forEach((t) => console.log(`    ${t}`));
    console.log('  Run `node setup.js` to fill the config.\n');
  } else {
    console.log('\n  Ready to deploy.\n');
  }
  console.log(cache.configured === false
    ? '  Cards      no CITO_API_KEY — page will show the setup state and live-sync when deployed'
    : `  Cards      ${cards.length} card(s) / ${cards.reduce((s, c) => s + c.count, 0)} bouts`);
}

main();
