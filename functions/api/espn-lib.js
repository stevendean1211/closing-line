// GENERATED from espn.js by build.js — do not edit.
/**
 * ESPN card parser — no API key, no signup, no quota.
 *
 * Card data: https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard
 * Odds:      https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/
 *              {eventId}/competitions/{competitionId}/odds
 *
 * These are the undocumented endpoints ESPN's own site runs on. They are public
 * and require no auth, but ESPN owes nobody stability — treat a shape change as
 * a when, not an if. `node fetch-card.js --verify` re-checks the contract.
 *
 * Shared by the CLI fetcher and the Cloudflare Function.
 */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const CORE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc';

const dec = (a) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
const amer = (p) => { if (!(p > 0 && p < 1)) return null; const d = 1 / p; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); };

/**
 * Section from start time, not a config file.
 *
 * A UFC card runs early prelims -> prelims -> main card, and every bout in a
 * block shares a start time. So the distinct times ARE the blocks: latest is
 * the main card, earliest is early prelims. Three blocks on a numbered card,
 * two on most Fight Nights — hence the length check rather than a fixed map.
 */
function sectionsByTime(bouts) {
  const times = [...new Set(bouts.map((b) => b.start))].sort();
  const labels = times.length >= 3
    ? ['Early Prelims', 'Prelims', 'Main Card']
    : times.length === 2 ? ['Prelims', 'Main Card'] : ['Main Card'];
  const map = {};
  times.forEach((t, i) => { map[t] = labels[Math.min(i, labels.length - 1)]; });
  // More than three blocks (rare, staggered starts) collapses into Main Card.
  if (times.length > 3) times.slice(3).forEach((t) => { map[t] = 'Main Card'; });
  return map;
}

/**
 * ESPN records the finish in a details[] entry. "Kotko" is their spelling of
 * KO/TKO — not a typo on our side.
 */
function methodOf(c) {
  const txt = (c.details || []).map((d) => d.type?.text || '').find((t) => /winner/i.test(t)) || '';
  if (/kotko|ko\/tko|knockout/i.test(txt)) return 'KO/TKO';
  if (/submission/i.test(txt)) return 'Submission';
  if (/decision/i.test(txt)) return 'Decision';
  if (/dq|disqualif/i.test(txt)) return 'DQ';
  if (/draw|no contest/i.test(txt)) return 'No contest';
  return null;
}

/**
 * Is this card finished?
 *
 * Two independent signals, because neither alone is enough:
 *
 *   - ESPN status. Authoritative when it updates, but it lags. Right now ESPN
 *     can still say IN_PROGRESS with the main event SCHEDULED well after the
 *     broadcast has ended.
 *   - Wall clock. If the last bout was scheduled more than STALE_HOURS ago,
 *     the card is over whatever ESPN thinks.
 *
 * Relying only on status leaves a dead card sitting on the site. Relying only
 * on the clock would drop a card that ran long. Either signal ends it.
 */
const STALE_HOURS = 6;

function cardState(card, now = Date.now()) {
  const fights = card.sections.flatMap((s) => s.fights);
  if (!fights.length) return 'pre';

  if (fights.every((f) => f.state === 'post')) return 'final';

  const last = Math.max(...fights.map((f) => new Date(f.start).getTime() || 0));
  if (last && now - last > STALE_HOURS * 3600e3) return 'final';

  if (fights.some((f) => f.state === 'in' || f.state === 'post')) return 'live';
  return 'pre';
}

/**
 * Contender Series is a UFC-promoted prospect showcase, not a UFC card. Books
 * barely price it and a UFC bettor doesn't want it as their board. It has to be
 * filtered in two places: here (the scoreboard's featured event) and in
 * nextCard() (the calendar). Filtering only the calendar leaves DWCS featured.
 */
const isDWCS = (name) => /contender series|dwcs/i.test(String(name || ''));

/** Scoreboard JSON -> one structured card. */
function parseCard(sb) {
  const ev = (sb.events || [])[0];
  if (!ev) return null;

  const comps = ev.competitions || [];
  const raw = comps.map((c) => {
    const cs = c.competitors || [];
    // ESPN's `order` is the corner, not the display side; sort so it's stable.
    const sorted = [...cs].sort((x, y) => (x.order || 0) - (y.order || 0));
    const side = (p) => {
      const a = p?.athlete || {};
      return {
        id: p?.id,
        name: a.fullName || a.displayName || 'TBD',
        record: (p?.records || []).find((r) => r.type === 'total')?.summary || null,
        champion: (a.accolades || []).some((x) => x.type === 'Belt'),
        won: p?.winner === true,
        best: null, book: null, consensus: null, fair: null,
      };
    };
    const st = c.status || {};
    const state = st.type?.state || 'pre';
    const winner = cs.find((p) => p.winner === true);
    return {
      id: c.id,
      eventId: ev.id,
      start: c.startDate || c.date,
      weight: c.type?.abbreviation || null,
      rounds: c.format?.regulation?.periods || 3,
      titleFight: cs.some((p) => (p.athlete?.accolades || []).some((x) => x.type === 'Belt')),
      state,
      completed: st.type?.completed === true,
      winnerId: winner?.id || null,
      winnerName: winner?.athlete?.fullName || null,
      method: methodOf(c),
      endedAt: st.type?.completed ? `R${st.period || '?'} ${st.displayClock || ''}`.trim() : null,
      a: side(sorted[0]),
      b: side(sorted[1]),
      hold: null, books: 0, priced: false,
    };
  });

  const secMap = sectionsByTime(raw);
  // Latest start + five rounds = main event. Falls back to plain latest.
  const byTime = [...raw].sort((x, y) => new Date(x.start) - new Date(y.start));
  const mainEvent = [...byTime].reverse().find((b) => b.rounds === 5) || byTime[byTime.length - 1];

  const fights = byTime.map((b, i) => ({
    ...b,
    bout: i + 1,
    section: secMap[b.start] || 'Main Card',
    isMain: b.id === mainEvent?.id,
  }));

  const order = ['Main Card', 'Prelims', 'Early Prelims'];
  const venue = comps[0]?.venue || (ev.venues || [])[0] || {};

  const card = {
    id: ev.id,
    name: ev.name || ev.shortName,
    short: ev.shortName || null,
    date: (ev.date || '').slice(0, 10),
    start: ev.date,
    venue: venue.fullName
      ? `${venue.fullName}${venue.address?.city ? `, ${venue.address.city}` : ''}${venue.address?.state ? `, ${venue.address.state}` : ''}`
      : null,
    count: fights.length,
    pricedCount: 0,
    sections: order
      .map((label) => ({ label, fights: fights.filter((f) => f.section === label).sort((x, y) => y.bout - x.bout) }))
      .filter((s) => s.fights.length),
  };
  card.state = cardState(card);
  card.finished = card.state === 'final';
  return card;
}

/** Upcoming cards from the season calendar, excluding Contender Series. */
function parseCalendar(sb, { limit = 6, includeDWCS = false } = {}) {
  const cal = (sb.leagues || [])[0]?.calendar || [];
  const now = Date.now();
  return cal
    .filter((c) => new Date(c.endDate || c.startDate).getTime() > now)
    .filter((c) => includeDWCS || !/contender series/i.test(c.label || ''))
    .map((c) => ({
      name: c.label,
      start: c.startDate,
      date: (c.startDate || '').slice(0, 10),
      eventId: (String(c.event?.$ref || '').match(/events\/(\d+)/) || [])[1] || null,
    }))
    .slice(0, limit);
}

/**
 * Bind ESPN odds to the correct fighter.
 *
 * This is the part that has to be right. A price shown against the wrong
 * fighter is worse than showing no price — it looks authoritative and it is
 * backwards. So binding runs strictly in order of certainty, and anything
 * unresolved is dropped rather than guessed:
 *
 *   1. athlete id      — exact, from the odds payload's athlete ref
 *   2. name match      — normalised (accents, apostrophes, non-decomposing ł)
 *   3. home/away slot  — only when the payload labels sides AND the competitor
 *                        order is known; recorded so --verify can show it
 *
 * Position in an array is never used. Arrays reorder; that is how prices end
 * up on the wrong man.
 */
const TRANSLIT = { 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ı': 'i', 'ŋ': 'n',
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'th', 'ð': 'd' };

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[łøđħıŋßæœþð]/g, (c) => TRANSLIT[c] || c)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/["\u201c\u201d].*?["\u201c\u201d]/g, ' ')
  .replace(/['\u2018\u2019]/g, '')
  .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

const surname = (s) => norm(s).split(' ').pop();

/** Pull an athlete id out of whatever field ESPN used. */
function athleteIdOf(node) {
  if (!node) return null;
  const direct = node.athleteId || node.athlete?.id || node.id;
  if (direct && /^\d+$/.test(String(direct))) return String(direct);
  const ref = node.athlete?.$ref || node.$ref || '';
  const m = String(ref).match(/athletes\/(\d+)/);
  return m ? m[1] : null;
}

function nameOf(node) {
  return node?.athlete?.fullName || node?.athlete?.displayName ||
         node?.displayName || node?.name || node?.shortName || null;
}

function moneylineOf(node) {
  const v = node?.moneyLine ?? node?.moneyline ?? node?.odds ?? node?.value ?? node?.american;
  const n = Number(String(v).replace('+', ''));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
}

/**
 * @param payload ESPN odds JSON
 * @param A {id, name}  fighter in competitor order 1
 * @param B {id, name}  fighter in competitor order 2
 */
function parseOdds(payload, A, B) {
  const items = payload?.items || (Array.isArray(payload) ? payload : payload ? [payload] : []);
  const bucketA = [], bucketB = [];
  const methods = new Set();

  for (const item of items) {
    const book = item.provider?.name || item.provider?.displayName ||
                 (item.provider?.id ? `provider ${item.provider.id}` : 'book');

    // Every shape ESPN uses for a two-sided market, normalised to {node, slot}.
    const sides = [];
    for (const [key, slot] of [['homeAthleteOdds', 'home'], ['awayAthleteOdds', 'away'],
                               ['homeTeamOdds', 'home'], ['awayTeamOdds', 'away']]) {
      if (item[key]) sides.push({ node: item[key], slot });
    }
    for (const c of (item.athleteOdds || item.competitors || item.outcomes || [])) {
      sides.push({ node: c, slot: null });
    }

    for (const { node, slot } of sides) {
      const price = moneylineOf(node);
      if (price === null) continue;

      // 1 — athlete id
      const aid = athleteIdOf(node);
      if (aid && (aid === String(A.id) || aid === String(B.id))) {
        (aid === String(A.id) ? bucketA : bucketB).push({ book, price });
        methods.add('athlete-id');
        continue;
      }

      // 2 — name
      const nm = nameOf(node);
      if (nm) {
        const n = norm(nm);
        if (n === norm(A.name) || surname(nm) === surname(A.name)) { bucketA.push({ book, price }); methods.add('name'); continue; }
        if (n === norm(B.name) || surname(nm) === surname(B.name)) { bucketB.push({ book, price }); methods.add('name'); continue; }
      }

      // 3 — home/away slot, only if the payload labelled it
      if (slot === 'home') { bucketA.push({ book, price }); methods.add('home-away'); }
      else if (slot === 'away') { bucketB.push({ book, price }); methods.add('home-away'); }
      // otherwise: unresolved, deliberately discarded
    }
  }

  if (!bucketA.length || !bucketB.length) return null;

  const side = (arr) => {
    const best = arr.reduce((x, e) => (dec(e.price) > dec(x.price) ? e : x));
    const avg = arr.map((e) => dec(e.price)).reduce((s, d) => s + d, 0) / arr.length;
    return { best: best.price, book: best.book, consensus: amer(1 / avg), p: 1 / avg };
  };
  const x = side(bucketA), y = side(bucketB), tot = x.p + y.p;

  // Sanity gate. A real two-way market's implied probabilities sum to a bit
  // over 1 — the vig. Wildly outside that means the two buckets aren't actually
  // opposite sides of the same fight, i.e. binding went wrong. Drop it.
  if (tot < 0.95 || tot > 1.35) return null;

  return {
    a: { best: x.best, book: x.book, consensus: x.consensus, fair: amer(x.p / tot), implied: Math.round((x.p / tot) * 1000) / 10 },
    b: { best: y.best, book: y.book, consensus: y.consensus, fair: amer(y.p / tot), implied: Math.round((y.p / tot) * 1000) / 10 },
    hold: Number(((tot - 1) * 100).toFixed(2)),
    books: Math.min(bucketA.length, bucketB.length),
    boundBy: [...methods].join('+') || 'none',
  };
}

/**
 * The next card to feature after `current` finishes.
 *
 * Works for any card type — numbered PPV, Fight Night, Noche, Freedom — because
 * it just walks the calendar. Contender Series is skipped by default; it isn't
 * what a UFC bettor means by "the next card".
 */
function nextCard(sb, currentId, { includeDWCS = false, now = Date.now() } = {}) {
  return parseCalendar(sb, { limit: 40, includeDWCS })
    .filter((c) => c.eventId !== String(currentId))
    .filter((c) => new Date(c.start).getTime() > now - 6 * 3600e3)
    .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
}

/** YYYYMMDD for ESPN's ?dates= filter. */
const dateParam = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');

export { SCOREBOARD, CORE, parseCard, parseCalendar, parseOdds, sectionsByTime };
