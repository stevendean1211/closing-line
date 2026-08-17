#!/usr/bin/env node
/**
 * Scans every cached card for a bout ESPN has priced, and dumps the raw
 * response so the parser can be matched to reality.
 *
 *   node diagnose.js
 */
const { SCOREBOARD, CORE, parseCard, parseCalendar, parseOdds, isDWCS, dateParam } = require('./espn.js');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; card-board/1.0)' };
const get = async (u) => { const r = await fetch(u, { headers: UA }); return r.ok ? r.json() : null; };
const raw = async (u) => { const r = await fetch(u, { headers: UA }); return { status: r.status, body: await r.text() }; };

(async () => {
  const sb = await get(SCOREBOARD);
  const cards = [];
  const featured = parseCard(sb);
  if (featured) cards.push(featured);

  // Try each upcoming non-DWCS card via the dates filter.
  for (const c of parseCalendar(sb, { limit: 4 })) {
    if (isDWCS(c.name)) continue;
    try {
      const d = parseCard(await get(`${SCOREBOARD}?dates=${dateParam(c.start)}`));
      if (d && d.sections.length && !cards.some((x) => x.id === d.id)) cards.push(d);
    } catch {}
  }

  console.log(`\n  Scanning ${cards.length} card(s) with published bouts...\n`);

  let found = null;
  for (const card of cards) {
    const fights = card.sections.flatMap((s) => s.fights);
    console.log(`  ${card.name}  (${fights.length} bouts)`);
    for (const f of fights) {
      const url = `${CORE}/events/${f.eventId}/competitions/${f.id}/odds`;
      const idx = await get(url);
      const n = idx?.count ?? 0;
      console.log(`    ${n > 0 ? '★' : ' '} count=${String(n).padEnd(3)} ${f.a.name} vs ${f.b.name}`);
      if (n > 0 && !found) found = { f, url, idx };
    }
    console.log();
  }

  if (!found) {
    console.log('  No priced bouts anywhere yet.\n');
    console.log('  This is expected right after a card ends — books have not posted lines');
    console.log('  for the next one, and ESPN mirrors the books. Re-run closer to fight week.\n');
    return;
  }

  console.log(`  PRICED BOUT FOUND: ${found.f.a.name} vs ${found.f.b.name}`);
  console.log(`  ${found.url}\n`);
  console.log('--- INDEX ---');
  console.log(JSON.stringify(found.idx, null, 2).slice(0, 900));

  const ref = found.idx.items?.[0]?.$ref;
  if (ref) {
    const deep = await raw(String(ref).replace('http://', 'https://'));
    console.log('\n--- FIRST $ref RESOLVED ---');
    console.log(deep.body.slice(0, 2000));
  }

  const items = await Promise.all((found.idx.items || []).map(async (it) =>
    it?.$ref ? await get(String(it.$ref).replace('http://', 'https://')) : it));
  const p = parseOdds({ items: items.filter(Boolean) },
    { id: found.f.a.id, name: found.f.a.name }, { id: found.f.b.id, name: found.f.b.name });

  console.log('\n--- PARSER RESULT ---');
  console.log(p ? JSON.stringify(p, null, 2) : '  null — parser could not bind. Paste the above.');
  console.log();
})();
