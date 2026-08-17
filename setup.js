#!/usr/bin/env node
/**
 * One-time setup. Fills data/site.json and clears the sample data.
 *
 *   node setup.js
 *   node setup.js --clean    only remove sample picks
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const P = (...a) => path.join(__dirname, ...a);
const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
};

const SAMPLES = [
  'data/picks/2026-07-11-ufc-318.json',
  'data/picks/2026-08-22-ufc-319.json',
  'data/premium/2026-08-29-ufc-320.json',
];

function clean() {
  let n = 0;
  for (const f of SAMPLES) {
    if (fs.existsSync(P(f))) { fs.unlinkSync(P(f)); n++; console.log(C.d(`  removed ${f}`)); }
  }
  console.log(n ? C.g(`\n  Cleared ${n} sample file(s). Your record starts empty — correct.\n`)
                : C.d('\n  No sample files found.\n'));
}

async function main() {
  if (process.argv.includes('--clean')) return clean();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(P('data/site.json'), 'utf8')); } catch { return {}; } })();

  const ask = async (label, key, hint) => {
    if (hint) console.log(C.d(`  ${hint}`));
    const cur = cfg[key] || '';
    const v = (await rl.question(`  ${label}${cur ? C.d(` [${cur}]`) : ''} `)).trim();
    cfg[key] = v || cur;
    console.log();
  };

  console.log(C.b('\n  Site setup\n'));
  console.log(C.d('  Blank keeps the current value. You can rerun this any time.\n'));

  await ask('Brand name:', 'brand', 'Shows in the header, page titles and the tale of the tape.');
  await ask('Tagline:', 'tagline', 'One line. Appears in meta description and social previews.');
  await ask('Monthly price label:', 'price', 'Display only, e.g. $59/mo. Real prices live in data/tiers.json.');
  await ask('Whop checkout URL:', 'whop_url', 'From your Whop product page. Leave blank until it exists.');
  await ask('Discord invite URL:', 'discord_url', 'Leave blank if you are launching Whop-only.');
  await ask('Public repo URL:', 'repo_url', 'The "don\'t trust me, check the log" link. This one matters most.');

  fs.writeFileSync(P('data/site.json'), JSON.stringify(cfg, null, 2) + '\n');
  console.log(C.g('  Wrote data/site.json\n'));

  if (SAMPLES.some((f) => fs.existsSync(P(f)))) {
    const yes = (await rl.question(`  ${C.y('Sample picks are still present.')} Remove them? ${C.d('(y/n)')} `))
      .toLowerCase().startsWith('y');
    console.log();
    if (yes) clean();
    else console.log(C.d('  Left in place. Run `node setup.js --clean` before you go live.\n'));
  }

  rl.close();
  console.log(C.d('  Next: node fetch-card.js && node build.js\n'));
}

main().catch((e) => { console.error(C.r(`\n  ${e.message}\n`)); process.exit(1); });
