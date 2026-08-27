import { neon } from '@neondatabase/serverless';
import { createHmac, timingSafeEqual } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);

/* The token stops anyone unsubscribing an address that isn't theirs by editing
   the query string. Derived from IP_SALT with a distinct label so the two uses
   can never produce the same value. */
function tokenFor(email) {
  return createHmac('sha256', (process.env.IP_SALT || 'no-salt-set') + '|unsubscribe')
    .update(String(email).trim().toLowerCase())
    .digest('base64url')
    .slice(0, 32);
}

export function unsubscribeUrl(email) {
  const base = process.env.SITE_URL || 'https://metaljewel.com';
  return `${base}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${tokenFor(email)}`;
}

export default async function handler(req, res) {
  const email = String(req.query?.e || '').trim().toLowerCase();
  const token = String(req.query?.t || '');

  if (!email || !tokenOk(email, token)) {
    return html(res, 400, 'Link not valid',
      'That unsubscribe link is incomplete or has been altered. ' +
      'Use the link exactly as it appears in the email, or reply to the email and I will remove you by hand.');
  }

  /* GET only confirms. Mail providers and security scanners follow links in
     emails automatically, and a GET that deleted on sight would unsubscribe
     people who never clicked anything. The deletion happens on POST. */
  if (req.method === 'GET') {
    return html(res, 200, 'Unsubscribe?',
      `Remove <strong>${escapeHtml(email)}</strong> and delete everything on file for it?`,
      `<form method="POST" action="/api/unsubscribe?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}">
         <button type="submit">Yes, remove me</button>
       </form>`);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return html(res, 405, 'Not allowed', 'That request type is not supported here.');
  }

  try {
    const rows = await sql`delete from contacts where email = ${email} returning id`;
    const removed = rows.length > 0;
    return html(res, 200, removed ? 'Removed' : 'Already gone',
      removed
        ? `<strong>${escapeHtml(email)}</strong> has been deleted. Name, phone number and message are gone with it, and you will not be emailed again.`
        : `There was nothing on file for <strong>${escapeHtml(email)}</strong>. Nothing to remove.`);
  } catch (err) {
    console.error('[unsubscribe] delete failed:', err?.message || err);
    return html(res, 500, 'Something went wrong',
      'I could not complete that just now. Reply to any of my emails and I will remove you by hand.');
  }
}

function tokenOk(email, supplied) {
  const expected = tokenFor(email);
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Self-contained page in the site's palette. No stylesheet to fetch, so it
   renders correctly even as the very first thing a stranger sees. */
function html(res, status, heading, body, extra = '') {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const site = process.env.SITE_URL || 'https://metaljewel.com';
  return res.status(status).send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} — Saad</title>
<style>
  :root{--bg:#0B1220;--surface:#142138;--line:rgba(237,241,248,.10);--ink:#EDF1F8;--ink-soft:#A7B2C8;--gold:#E6AE45}
  @media (prefers-color-scheme:light){
    :root{--bg:#F5F7FB;--surface:#FFF;--line:rgba(22,34,59,.12);--ink:#16223B;--ink-soft:#54617B;--gold:#B97F16}
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);min-height:100vh;display:grid;place-items:center;
       padding:2rem 1.25rem;font:400 16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:2.4rem;max-width:34rem;width:100%}
  h1{font-size:1.5rem;font-weight:600;letter-spacing:-.02em;margin-bottom:.9rem}
  p{color:var(--ink-soft)}
  strong{color:var(--ink);font-weight:600}
  button{margin-top:1.6rem;background:var(--gold);color:#161005;border:0;border-radius:12px;
         padding:.85rem 1.5rem;font:inherit;font-weight:600;cursor:pointer}
  button:hover{opacity:.9}
  a{color:var(--gold);margin-top:1.6rem;display:inline-block;font-size:.9rem}
</style>
</head><body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${body}</p>
    ${extra}
    <a href="${site}">&larr; Back to the site</a>
  </div>
</body></html>`);
}
