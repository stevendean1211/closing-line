/**
 * POST /api/picks   { "key": "<whop license key>" }
 *
 * The paywall. Premium picks are bundled into this Function at deploy time and
 * are NOT part of the static site — nothing in dist/ contains a selection.
 * A key is validated against Whop server-side before anything is returned.
 *
 * Setup — Cloudflare Pages -> Settings -> Environment variables (encrypted):
 *   WHOP_API_KEY      from Whop dashboard -> Developers
 *   WHOP_PRODUCT_ID   optional; if set, the membership must match this product
 *
 * Why bundled rather than read from disk: Pages Functions can't read the repo
 * at runtime. `node build.js` writes premium-data.js next to this file, and it
 * is gitignored from dist/ so it never ships to a browser.
 */

import PREMIUM from './premium-data.js';

const CORS = { 'Content-Type': 'application/json' };

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Bad request' }, 400); }

  const key = (body.key || '').trim();
  if (!key) return json({ error: 'No key provided' }, 400);

  if (!env.WHOP_API_KEY) {
    return json({ error: 'Paywall not configured on the server' }, 503);
  }

  // Validate against Whop. The {id} path segment accepts a license key
  // directly as well as a mem_* id.
  let res;
  try {
    res = await fetch(
      `https://api.whop.com/api/v2/memberships/${encodeURIComponent(key)}/validate_license`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHOP_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: {} }),
      }
    );
  } catch {
    return json({ error: 'Could not reach the payment provider. Try again shortly.' }, 502);
  }

  if (res.status === 404 || res.status === 400) {
    return json({ error: 'That key is not recognised.' }, 403);
  }
  if (!res.ok) {
    return json({ error: 'Validation failed. Try again shortly.' }, 502);
  }

  const membership = await res.json();

  // A key can exist but be expired, cancelled, or refunded.
  const live = membership.valid === true &&
    ['active', 'trialing', 'completed'].includes(String(membership.status || '').toLowerCase());
  if (!live) {
    return json({ error: 'That membership is not currently active.', status: membership.status }, 403);
  }

  // If you sell more than one product, make sure this key is for this one.
  if (env.WHOP_PRODUCT_ID) {
    const product = typeof membership.product === 'string' ? membership.product : membership.product?.id;
    if (product !== env.WHOP_PRODUCT_ID) {
      return json({ error: 'That membership is for a different product.' }, 403);
    }
  }

  return json({
    ok: true,
    expires_at: membership.expires_at || membership.renewal_period_end || null,
    cards: PREMIUM,
  }, 200, { 'Cache-Control': 'no-store' });
}

// Anything other than POST gets nothing useful.
export const onRequest = ({ request }) =>
  request.method === 'POST'
    ? undefined
    : json({ error: 'POST a license key to this endpoint.' }, 405);

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, ...extra } });
}
