/**
 * GET /api/card — live UFC cards + odds from ESPN's public endpoints.
 *
 * No API key. No env vars. No quota. Deploy it and it works.
 *
 * Edge-cached (CARD_TTL, default 300s) purely to be a good citizen: ESPN
 * publishes no rate limits and owes us nothing, so we don't hammer them.
 */
import { SCOREBOARD, CORE, isDWCS, parseCard, parseCalendar, parseOdds, nextCard, dateParam } from './espn-lib.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; card-board/1.0)' };

export async function onRequestGet(context) {
  const ttl = Number(context.env.CARD_TTL || 300);
  const cache = caches.default;
  const key = new Request('https://internal/ufc-espn-v1');

  const hit = await cache.match(key);
  if (hit) return hit;

  let cards = [];
  try {
    const sb = await get(SCOREBOARD);
    let featured = parseCard(sb);

    // Roll forward past finished cards and Contender Series.
    for (let hop = 0; hop < 3 && featured && (featured.finished || isDWCS(featured.name)); hop++) {
      const next = nextCard(sb, featured.id);
      if (!next) { featured = null; break; }
      const parsed = parseCard(await get(`${SCOREBOARD}?dates=${dateParam(next.start)}`));
      if (!parsed || parsed.id === featured.id) { featured = null; break; }
      featured = parsed;
    }

    if (featured && !isDWCS(featured.name)) cards.push(await priceCard(featured));

    // Fetch each upcoming card individually. The default scoreboard only ever
    // returns ONE event, so without this every other card renders as a bare
    // name and date — even when ESPN has the full bout list published.
    const upcoming = parseCalendar(sb, { limit: 5 })
      .filter((c) => !featured || c.eventId !== String(featured.id))
      .filter((c) => new Date(c.start).getTime() > Date.now() - 6 * 3600e3);

    const fetched = await Promise.all(upcoming.map(async (c) => {
      try {
        const parsed = parseCard(await get(`${SCOREBOARD}?dates=${dateParam(c.start)}`));
        if (parsed && parsed.sections.length && String(parsed.id) === String(c.eventId)) {
          return await priceCard(parsed);
        }
      } catch { /* fall through to the stub */ }
      // Genuinely unpublished — show the card exists, with no invented bouts.
      return { id: c.eventId, name: c.name, date: c.date, start: c.start,
        venue: null, count: 0, pricedCount: 0, sections: [], announced: true, state: 'pre' };
    }));
    cards.push(...fetched);

  } catch (e) {
    // Fail soft — the page keeps whatever it rendered from the build cache.
    return json({ configured: true, cards: [], error: String(e.message).slice(0, 160) });
  }

  const out = json({ fetched_at: new Date().toISOString(), configured: true, cards },
    { 'Cache-Control': `public, max-age=${ttl}` });
  context.waitUntil(cache.put(key, out.clone()));
  return out;
}

async function get(url) {
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: 120 } });
  if (!r.ok) throw new Error(`${r.status} on ${new URL(url).pathname}`);
  return r.json();
}


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

async function priceCard(card) {
  const fights = card.sections.flatMap((s) => s.fights);
  let ok = 0;
  await Promise.all(fights.map(async (f) => {
    try {
      const p = await fetchOdds(f, get);
      if (p) {
        Object.assign(f.a, p.a); Object.assign(f.b, p.b);
        f.hold = p.hold; f.books = p.books; f.boundBy = p.boundBy; f.priced = true; ok++;
      }
    } catch { /* unpriced is normal */ }
  }));
  card.pricedCount = ok;
  return card;
}

const json = (body, extra = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...extra } });
