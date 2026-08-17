#!/usr/bin/env node
/**
 * Pulls real upcoming UFC cards from ESPN's public endpoints into
 * data/card-cache.json. No API key. No signup. No quota.
 *
 *   node fetch-card.js
 *   node fetch-card.js --verify    check ESPN's shape hasn't drifted
 */
const fs = require('fs');
const path = require('path');
const { SCOREBOARD, CORE, isDWCS, parseCard, parseCalendar, parseOdds, nextCard, dateParam } = require('./espn.js');

const OUT = path.join(__dirname, 'data', 'card-cache.json');
const VERIFY = process.argv.includes('--verify');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; card-board/1.0)' };

const get = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};


/**
 * ESPN's core API paginates with $ref stubs — `/odds` returns
 * {count, items:[{$ref}]} rather than the odds themselves. Resolve one level
 * before parsing. count:0 means the bout genuinely has no line, which is the
 * normal state for prospects and for any card more than a few days out.
 */
async function fetchOdds(f, get) {
  const idx = await get(`${CORE}/events/${f.eventId}/competitions/${f.id}/odds`);
  if (!idx || !idx.count || !Array.isArray(idx.items) || !idx.items.length) return null;

  const items = await Promise.all(idx.items.map(async (it) => {
    if (!it || !it.$ref) return it;
    try { return await get(String(it.$ref).replace('http://', 'https://')); }
    catch { return null; }
  }));

  return parseOdds({ items: items.filter(Boolean) },
    { id: f.a.id, name: f.a.name }, { id: f.b.id, name: f.b.name });
}

/** Attach odds to each bout. */
async function priceCard(card) {
  let ok = 0;
  await Promise.all(card.sections.flatMap((s) => s.fights).map(async (f) => {
    try {
      const p = await fetchOdds(f, get);
      if (p) {
        Object.assign(f.a, p.a); Object.assign(f.b, p.b);
        f.hold = p.hold; f.books = p.books; f.boundBy = p.boundBy; f.priced = true; ok++;
      }
    } catch { /* unpriced bout is a normal state, not an error */ }
  }));
  card.pricedCount = ok;
  return card;
}

async function verify() {
  console.log('\n  Checking ESPN endpoints...\n');
  const sb = await get(SCOREBOARD);
  const card = parseCard(sb);
  if (!card) return console.log('  !! No event in scoreboard — parseCard() needs attention.');
  console.log(`  scoreboard   OK — ${card.name}`);
  console.log(`               ${card.count} bouts · ${card.sections.map((s) => `${s.label} ${s.fights.length}`).join(' · ')}`);
  console.log(`               venue: ${card.venue || '(none)'}`);
  const main = card.sections[0].fights.find((f) => f.isMain);
  console.log(`               main event: ${main ? `${main.a.name} vs ${main.b.name}` : '(not identified)'}`);
  console.log(`  calendar     OK — ${parseCalendar(sb).length} upcoming card(s)`);

  const f = card.sections[0].fights[0];
  const url = `${CORE}/events/${f.eventId}/competitions/${f.id}/odds`;
  try {
    const raw = await get(url);
    const p = parseOdds(raw, { id: f.a.id, name: f.a.name }, { id: f.b.id, name: f.b.name });
    if (p) {
      const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
      console.log(`  odds         OK — bound by ${p.boundBy}`);
      console.log(`               ${f.a.name.padEnd(22)} ${sign(p.a.best).padStart(6)} (${p.a.book})  implied ${p.a.implied}%  fair ${sign(p.a.fair)}`);
      console.log(`               ${f.b.name.padEnd(22)} ${sign(p.b.best).padStart(6)} (${p.b.book})  implied ${p.b.implied}%  fair ${sign(p.b.fair)}`);
      console.log(`               ${p.books} book(s) · ${p.hold}% hold`);
      if (p.boundBy === 'home-away') console.log(`               NOTE: fell back to slot binding — spot-check one fight against a sportsbook.`);
    } else {
      console.log(`  odds         reachable but no usable moneyline bound.`);
      console.log(`               (this is also what you see when a bout genuinely has no line yet)`);
      console.log(`               raw keys: ${Object.keys(raw).join(', ')}`);
      console.log(`               first item: ${JSON.stringify((raw.items || [])[0] || raw).slice(0, 400)}`);
      console.log(`               ^ adjust parseOdds() in espn.js to match.`);
    }
  } catch (e) {
    console.log(`  odds         unavailable (${e.message})`);
    console.log(`               cards still work; bouts show "not yet priced".`);
  }
  console.log();
}

/**
 * The featured card, rolling forward past anything already finished.
 *
 * ESPN keeps a completed event on the default scoreboard for a while, so the
 * first response is often last night's card. Walk forward until we land on one
 * that hasn't finished. Capped at 3 hops so a bad calendar can't spin.
 */
async function featuredCard() {
  let sb = await get(SCOREBOARD);
  let card = parseCard(sb);
  const skipped = [];

  for (let hop = 0; hop < 3; hop++) {
    if (card && !card.finished && !isDWCS(card.name)) return { sb, card, skipped };
    const next = nextCard(sb, card?.id);
    if (!next) break;
    if (card) skipped.push(`${card.name} (${isDWCS(card.name) ? 'contender series' : card.state})`);
    const dated = await get(`${SCOREBOARD}?dates=${dateParam(next.start)}`);
    const parsed = parseCard(dated);
    // ?dates= can echo the same event; if so, fall back to the calendar stub.
    if (!parsed || parsed.id === card?.id) {
      return { sb, card: { id: next.eventId, name: next.name, date: next.date, start: next.start,
        venue: null, count: 0, pricedCount: 0, sections: [], announced: true, state: 'pre' }, skipped };
    }
    card = parsed;
  }
  return { sb, card, skipped };
}

async function main() {
  if (VERIFY) return verify();

  const { sb, card, skipped } = await featuredCard();
  const cards = [];
  if (card && !card.announced) cards.push(await priceCard(card));
  else if (card) cards.push(card);

  for (const c of parseCalendar(sb, { limit: 6 })) {
    if (card && c.eventId === String(card.id)) continue;
    if (new Date(c.start).getTime() < Date.now()) continue;
    cards.push({ id: c.eventId, name: c.name, date: c.date, start: c.start,
      venue: null, count: 0, pricedCount: 0, sections: [], announced: true, state: 'pre' });
  }

  fs.writeFileSync(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), configured: true, cards }, null, 2));
  console.log(`\n  ${cards.length} card(s) cached — no API key used`);
  for (const s of skipped) console.log(`    rolled past  ${s}`);
  for (const c of cards) {
    console.log(`    ${c.date}  ${c.name}${c.announced ? '  (announced)' : `  — ${c.count} bouts, ${c.pricedCount} priced, ${c.state}`}`);
  }
  console.log();
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n  Failed: ${e.message}\n  Existing cache kept.\n`); process.exit(0); });
}
