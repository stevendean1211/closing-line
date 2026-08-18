#!/usr/bin/env node
/**
 * Pick logger. The tool you'll actually touch every week.
 *
 *   node log.js add            log a FREE pick — public immediately
 *   node log.js add --premium  log a PAID pick — never enters the HTML
 *   node log.js grade          fill in closing lines + results
 *   node log.js release        move graded premium picks to the public record
 *   node log.js status         what's still open
 *
 * Design note: grading never writes a closing line you haven't looked at.
 * The odds API suggests, you confirm. Automating that confirmation away
 * would put silent errors in the ledger, and the ledger is the product.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const PICKS_DIR = path.join(__dirname, 'data', 'picks');
const PREMIUM_DIR = path.join(__dirname, 'data', 'premium');
const ODDS_CACHE = path.join(__dirname, 'data', 'odds-cache.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const C = {
  d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------
async function ask(q, { required = true, def = null } = {}) {
  for (;;) {
    const hint = def !== null ? C.d(` [${def}]`) : '';
    const v = (await rl.question(`${q}${hint} `)).trim();
    if (!v && def !== null) return def;
    if (!v && !required) return null;
    if (v) return v;
    console.log(C.r('  required'));
  }
}

async function askOdds(q, { required = true } = {}) {
  for (;;) {
    const v = await ask(q, { required });
    if (v === null) return null;
    const n = Number(v.replace('+', ''));
    if (Number.isInteger(n) && Math.abs(n) >= 100) return n;
    console.log(C.r('  American odds, e.g. -145 or +210'));
  }
}

async function askNum(q, def) {
  for (;;) {
    const v = await ask(q, { def: String(def) });
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    console.log(C.r('  positive number'));
  }
}

async function askOne(q, opts) {
  const keys = opts.map((o) => o[0]).join('/');
  for (;;) {
    const v = (await ask(`${q} ${C.d(`(${keys})`)}`)).toLowerCase();
    const hit = opts.find((o) => o[0].toLowerCase() === v[0]);
    if (hit) return hit;
    console.log(C.r(`  one of: ${keys}`));
  }
}

const yes = async (q) => (await ask(`${q} ${C.d('(y/n)')}`)).toLowerCase().startsWith('y');

// ---------------------------------------------------------------------------
// Fighter name matching — suggest only, never decide
// ---------------------------------------------------------------------------
// Characters that survive NFD decomposition intact and would otherwise become
// word-breaking spaces. MMA rosters are full of these — Błachowicz, Jędrzejczyk,
// Øverland, Ćirković. Getting this wrong silently rejects real matches.
const TRANSLIT = { 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ı': 'i', 'ŋ': 'n',
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'th', 'ð': 'd', 'ŧ': 't', 'ĸ': 'k' };

const normalize = (s) =>
  s.toLowerCase().replace(/[łøđħıŋßæœþðŧĸ]/g, (c) => TRANSLIT[c] || c)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/["\u201c\u201d].*?["\u201c\u201d]/g, ' ') // strip "Bones"-style nicknames
    .replace(/['\u2018\u2019]/g, '')                    // O'Malley -> omalley, not "o malley"
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

function levenshtein(a, b) {
  const m = Array.from({ length: b.length + 1 }, (_, i) => [i, ...Array(a.length).fill(0)]);
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1));
  return m[b.length][a.length];
}

/** 0..1. Blends surname exactness with whole-string distance. */
function similarity(a, b) {
  const A = normalize(a), B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;

  const ta = A.split(' '), tb = B.split(' ');
  const surname = ta[ta.length - 1] === tb[tb.length - 1] ? 1 : 0;
  const shared = ta.filter((t) => tb.includes(t)).length / Math.max(ta.length, tb.length);
  const dist = 1 - levenshtein(A, B) / Math.max(A.length, B.length);

  return 0.45 * surname + 0.25 * shared + 0.3 * dist;
}

function bestMatch(name, fights) {
  let best = null;
  for (const f of fights) {
    for (const side of ['a', 'b']) {
      const score = similarity(name, f[side].name);
      if (!best || score > best.score) best = { score, fight: f, side, name: f[side].name };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
const loadFrom = (dir, premium) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: f, full: path.join(dir, f), premium,
          data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    : [];

const loadFiles = () =>
  [...loadFrom(PICKS_DIR, false), ...loadFrom(PREMIUM_DIR, true)]
    .sort((x, y) => new Date(y.data.date) - new Date(x.data.date));

const save = (e) => fs.writeFileSync(e.full, JSON.stringify(e.data, null, 2) + '\n');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------------------
/**
 * Bulk entry. One pick per line, pipe-separated:
 *
 *   selection | odds | book | units | fight (optional)
 *
 * CLV grading needs the price you actually took and the book you took it at,
 * so those aren't optional — a selection alone can't be graded against a close.
 * Everything else has a sensible default.
 */
function parseBulkLine(line, n, base) {
  const parts = line.split('|').map((x) => x.trim()).filter((x, i) => i === 0 || x !== '');
  if (parts.length < 2) return { error: 'need at least: selection | odds' };

  const [selection, oddsRaw, book, unitsRaw, fight] = parts;
  const odds = Number(String(oddsRaw).replace(/[+\s]/g, ''));
  if (!Number.isInteger(odds) || Math.abs(odds) < 100) return { error: `bad odds "${oddsRaw}"` };

  const units = unitsRaw ? Number(unitsRaw) : 1;
  if (!Number.isFinite(units) || units <= 0) return { error: `bad units "${unitsRaw}"` };

  const sel = selection.toLowerCase();
  const market = /submission|sub\b/.test(sel) ? 'method'
    : /ko|tko|knockout/.test(sel) ? 'method'
    : /decision|dec\b/.test(sel) ? 'method'
    : /parlay|\+/.test(sel) ? 'parlay'
    : /over|under|round/.test(sel) ? 'total'
    : 'moneyline';

  return {
    pick: {
      id: `${base}-${String(n).padStart(2, '0')}`,
      fight: fight || selection.replace(/\s+(by|ml)\b.*$/i, '').trim(),
      selection, market, line_taken: odds,
      book: book || 'DraftKings',
      units,
      posted_at: new Date().toISOString(),
      closing_line: null, result: null,
    },
  };
}

async function cmdBulk(premium) {
  const dir = premium ? PREMIUM_DIR : PICKS_DIR;
  const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1];
  console.log(C.b(`\n  Bulk ${premium ? C.y('PAID') : C.g('FREE')} picks\n`));
  console.log(C.d('  One per line:  selection | odds | book | units | fight'));
  console.log(C.d('  Book, units and fight are optional (default DraftKings, 1u).\n'));
  if (!fileArg) {
    // Pasting several lines at once is unreliable — the terminal delivers them
    // faster than readline consumes them and the middle ones get swallowed.
    // Say so plainly rather than letting picks silently disappear.
    console.log(C.y('  Paste ONE line at a time, Enter after each. Blank line to finish.'));
    console.log(C.d('  Several at once and some will be dropped — use --file= instead:\n'));
    console.log(C.d('    node log.js bulk --premium --file=picks.txt\n'));
  }

  const event = await ask('  Event name:');
  const date = await ask('  Date (YYYY-MM-DD):', { def: new Date().toISOString().slice(0, 10) });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.log(C.r('  Bad date.')); return; }

  const file = path.join(dir, `${date}-${slug(event)}.json`);
  let data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : (premium ? { event, date, released_at: new Date().toISOString(), picks: [] } : { event, date, picks: [] });

  const base = slug(event).replace(/-/g, '');
  const show = (p) => console.log(C.g(`      ✓ ${p.selection} ${p.line_taken > 0 ? '+' : ''}${p.line_taken} · ${p.units}u · ${p.book} · ${p.market}`));
  console.log();

  if (fileArg) {
    // Reading from a file sidesteps the paste problem entirely.
    const full = path.isAbsolute(fileArg) ? fileArg : path.join(__dirname, fileArg);
    if (!fs.existsSync(full)) { console.log(C.r(`  No such file: ${fileArg}\n`)); return; }
    const lines = fs.readFileSync(full, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    console.log(C.d(`  Reading ${lines.length} line(s) from ${fileArg}\n`));
    for (const line of lines) {
      const r = parseBulkLine(line, data.picks.length + 1, base);
      if (r.error) { console.log(C.r(`  ✗ ${line}`)); console.log(C.r(`      ${r.error}`)); continue; }
      data.picks.push(r.pick);
      show(r.pick);
    }
  } else {
    for (;;) {
      const line = (await rl.question(`  ${C.c(String(data.picks.length + 1))} > `)).trim();
      if (!line) break;
      // A pasted blob arrives as one string with embedded newlines — split it
      // rather than mangling it into a single unparseable pick.
      for (const one of line.split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean)) {
        const r = parseBulkLine(one, data.picks.length + 1, base);
        if (r.error) { console.log(C.r(`      ${one} — ${r.error}`)); continue; }
        data.picks.push(r.pick);
        show(r.pick);
      }
    }
  }

  if (!data.picks.length) { console.log(C.d('\n  Nothing entered.\n')); return; }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(C.b(`\n  Wrote ${path.relative(__dirname, file)} — ${data.picks.length} pick(s)\n`));
  if (premium) console.log(C.y('  PAID. Not rendered into any page. Post them in Whop Forums.\n'));
  console.log(`    git add data/ && git commit -m "add: ${event} ${premium ? 'premium ' : ''}picks (${data.picks.length})" && git push\n`);
}

// ---------------------------------------------------------------------------
async function cmdAdd(premium) {
  const dir = premium ? PREMIUM_DIR : PICKS_DIR;
  console.log(C.b(`\n  Log ${premium ? C.y('PAID') : C.g('FREE')} picks for a card\n`));
  console.log(C.d(premium
    ? '  These never appear in the site HTML. Members read them in Whop Forums.\n'
    : '  These are public immediately — this is your funnel and your proof.\n'));

  const event = await ask('  Event name (e.g. UFC 321):');
  const date = await ask('  Date (YYYY-MM-DD):', { def: new Date().toISOString().slice(0, 10) });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.log(C.r('  Bad date format.')); return; }

  const file = path.join(dir, `${date}-${slug(event)}.json`);
  let data = premium
    ? { event, date, released_at: new Date().toISOString(), picks: [] }
    : { event, date, picks: [] };
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(C.y(`  Existing file — ${data.picks.length} pick(s). Appending.\n`));
  }

  const base = slug(event).replace(/-/g, '');
  for (let n = data.picks.length + 1; ; n++) {
    console.log(C.c(`\n  — Pick ${n} —`));
    const fight = await ask('  Fight (A vs B):');
    const selection = await ask('  Your selection:');
    const [, market] = await askOne('  Market:', [
      ['m', 'moneyline'], ['t', 'total'], ['d', 'method'], ['p', 'prop'], ['r', 'parlay'],
    ]);
    const line_taken = await askOdds('  Price you took:');
    const book = await ask('  Book:', { def: 'DraftKings' });
    const units = await askNum('  Units:', 1);
    const note = await ask('  Note (optional):', { required: false });

    data.picks.push({
      id: `${base}-${String(n).padStart(2, '0')}`,
      fight, selection, market, line_taken, book, units,
      posted_at: new Date().toISOString(),
      closing_line: null, result: null,
      ...(note ? { note } : {}),
    });

    console.log(C.g(`  ✓ ${selection} ${line_taken > 0 ? '+' : ''}${line_taken} · ${units}u`));
    if (!(await yes('\n  Another pick?'))) break;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

  console.log(C.b(`\n  Wrote ${path.relative(__dirname, file)} — ${data.picks.length} pick(s)\n`));
  if (premium) {
    console.log(C.y('  PAID picks. Not rendered into any page — build.js fails if they leak.'));
    console.log(C.d('  Post them in Whop Forums now, then commit:\n'));
  } else {
    console.log(C.d('  Commit BEFORE the card starts. That ordering is the whole point:\n'));
  }
  console.log(`    git add data/ && git commit -m "add: ${event} ${premium ? 'premium ' : ''}picks (${data.picks.length})" && git push\n`);
}

// ---------------------------------------------------------------------------
async function cmdGrade() {
  const files = loadFiles();
  const open = files.filter((e) => e.data.picks.some((p) => !p.result));
  if (!open.length) { console.log(C.g('\n  Nothing open. Everything is graded.\n')); return; }

  console.log(C.b('\n  Grade open picks\n'));
  open.forEach((e, i) => {
    const n = e.data.picks.filter((p) => !p.result).length;
    console.log(`  ${C.c(String(i + 1))}  ${e.premium ? C.y('[PAID]') : C.g('[FREE]')} ${e.data.event} ${C.d(`(${e.data.date}) — ${n} open`)}`);
  });

  const pick = Number(await ask(`\n  Which card?`, { def: '1' })) - 1;
  const entry = open[pick];
  if (!entry) { console.log(C.r('  No such card.')); return; }

  let fights = [];
  try {
    const cache = JSON.parse(fs.readFileSync(ODDS_CACHE, 'utf8'));
    fights = cache.fights || [];
    if (fights.length) console.log(C.d(`\n  Odds cache: ${fights.length} fights (${cache.fetched_at || 'unknown'})`));
  } catch { /* fine — manual entry */ }
  if (!fights.length) console.log(C.d('\n  No odds cache. Run `node fetch-odds.js` first for suggestions.'));

  for (const p of entry.data.picks) {
    if (p.result) continue;

    console.log(C.c(`\n  — ${p.selection} ${C.d(`(${p.fight})`)} —`));
    console.log(C.d(`     took ${p.line_taken > 0 ? '+' : ''}${p.line_taken} · ${p.units}u · ${p.book}`));

    let suggested = null;
    if (fights.length && p.market === 'moneyline') {
      const m = bestMatch(p.selection, fights);
      if (m && m.score > 0.55) {
        const price = m.fight[m.side].consensus;
        const conf = m.score > 0.85 ? C.g('high') : m.score > 0.7 ? C.y('medium') : C.r('LOW');
        console.log(`     match: ${C.b(m.name)} @ ${price > 0 ? '+' : ''}${price} ${C.d(`(confidence ${conf})`)}`);
        if (m.score < 0.85) console.log(C.y('     ⚠ verify this is the right fighter before accepting'));
        suggested = price;
      } else {
        console.log(C.d('     no confident match in the odds cache'));
      }
    }

    let closing = null;
    if (suggested !== null && (await yes(`     Use ${suggested > 0 ? '+' : ''}${suggested} as the close?`))) {
      closing = suggested;
    } else {
      closing = await askOdds('     Closing line:', { required: false });
    }

    const [, result] = await askOne('     Result:', [['w', 'W'], ['l', 'L'], ['p', 'P'], ['s', null]]);
    if (result === null) { console.log(C.d('     skipped')); continue; }

    p.closing_line = closing;
    p.result = result;

    if (closing !== null) {
      const dec = (o) => (o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1);
      const clv = (dec(p.line_taken) / dec(closing) - 1) * 100;
      const tag = clv > 0 ? C.g(`+${clv.toFixed(1)}% — beat the close`) : C.r(`${clv.toFixed(1)}% — missed it`);
      console.log(`     CLV ${tag}`);
    }
  }

  save(entry);
  console.log(C.b(`\n  Updated ${entry.file}\n`));
  console.log(C.d('  Second commit. Grading only — no other edits:\n'));
  console.log(`    git add data/ && git commit -m "grade: ${entry.data.event}" && git push\n`);
  if (entry.premium && entry.data.picks.every((p) => p.result)) {
    console.log(C.y('  This paid card is fully graded. Make it public:\n'));
    console.log('    node log.js release\n');
  }
}

// ---------------------------------------------------------------------------
/**
 * Move fully-graded paid picks into the public record.
 *
 * This is what keeps the paywall honest. Subscribers pay for TIMING — the picks
 * before the bell — not for information that stays hidden. Once a card is
 * graded, every pick lands on the public ledger, winners and losers alike.
 *
 * Without this step the record only ever shows free picks, and "every pick I've
 * made is public" quietly stops being true.
 */
async function cmdRelease() {
  const premium = loadFrom(PREMIUM_DIR, true);
  const ready = premium.filter((e) => e.data.picks.length && e.data.picks.every((p) => p.result));

  if (!premium.length) { console.log(C.d('\n  No paid cards logged.\n')); return; }
  if (!ready.length) {
    console.log(C.y('\n  No fully-graded paid cards yet.\n'));
    for (const e of premium) {
      const open = e.data.picks.filter((p) => !p.result).length;
      console.log(`  ${e.data.event} ${C.d(`— ${open} pick(s) still open`)}`);
    }
    console.log(C.d('\n  Grade them first: node log.js grade\n'));
    return;
  }

  console.log(C.b('\n  Release graded paid picks to the public record\n'));
  for (const e of ready) {
    const w = e.data.picks.filter((p) => p.result === 'W').length;
    const l = e.data.picks.filter((p) => p.result === 'L').length;
    console.log(`  ${e.data.event} ${C.d(`— ${e.data.picks.length} pick(s), ${w}-${l}`)}`);
  }

  if (!(await yes('\n  Move these to the public record?'))) {
    console.log(C.d('\n  Left in place.\n'));
    return;
  }

  fs.mkdirSync(PICKS_DIR, { recursive: true });
  for (const e of ready) {
    const target = path.join(PICKS_DIR, e.file);
    if (fs.existsSync(target)) {
      // Merge rather than clobber — a card can have both free and paid picks.
      const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
      const ids = new Set(existing.picks.map((p) => p.id));
      existing.picks.push(...e.data.picks.filter((p) => !ids.has(p.id)));
      fs.writeFileSync(target, JSON.stringify(existing, null, 2) + '\n');
      console.log(C.g(`  merged into ${e.file}`));
    } else {
      const { released_at, ...rest } = e.data;
      fs.writeFileSync(target, JSON.stringify(rest, null, 2) + '\n');
      console.log(C.g(`  moved ${e.file}`));
    }
    fs.unlinkSync(e.full);
  }

  console.log(C.b('\n  Done. Rebuild and push:\n'));
  console.log('    node build.js');
  console.log(`    git add data/ && git commit -m "release: paid picks to public record" && git push\n`);
}

// ---------------------------------------------------------------------------
async function cmdStatus() {
  const files = loadFiles();
  if (!files.length) { console.log(C.y('\n  No picks logged yet. `node log.js add` to start.\n')); return; }

  const all = files.flatMap((e) => e.data.picks);
  const open = all.filter((p) => !p.result);
  const missing = all.filter((p) => p.result && p.closing_line == null);

  console.log(C.b(`\n  ${files.length} card(s) · ${all.length} pick(s)\n`));
  for (const e of files) {
    const o = e.data.picks.filter((p) => !p.result).length;
    console.log(`  ${e.data.date}  ${e.data.event.padEnd(18)} ${C.d(`${e.data.picks.length} pick(s)`)}` +
      (o ? `  ${C.y(`${o} open`)}` : `  ${C.g('graded')}`));
  }
  if (open.length) console.log(C.y(`\n  ${open.length} awaiting grade — \`node log.js grade\``));
  if (missing.length) console.log(C.r(`\n  ${missing.length} graded without a closing line. Those don't count toward CLV.`));
  console.log();
}

// ---------------------------------------------------------------------------
(async () => {
  const cmd = process.argv[2];
  try {
    const prem = process.argv.includes('--premium');
    if (cmd === 'bulk') await cmdBulk(prem);
    else if (cmd === 'add') await cmdAdd(prem);
    else if (cmd === 'release') await cmdRelease();
    else if (cmd === 'grade') await cmdGrade();
    else if (cmd === 'status') await cmdStatus();
    else {
      console.log(`
  ${C.b('Pick logger')}

    node log.js add             log a FREE pick, one field at a time
    node log.js add --premium   log a PAID pick
    node log.js bulk            paste several picks at once
    node log.js bulk --premium  paste several PAID picks
    node log.js grade           fill in closing lines and results
    node log.js release         move graded paid picks to the public record
    node log.js status          what's still open

  Then: node build.js
`);
    }
  } catch (e) {
    console.error(C.r(`\n  ${e.message}\n`));
  } finally {
    rl.close();
  }
})();
