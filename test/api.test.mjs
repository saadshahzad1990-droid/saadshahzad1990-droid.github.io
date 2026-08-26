/* Exercises both handlers with Resend and Neon stubbed out.
   No network, no credentials, no database. Run with `npm test`. */

process.env.DATABASE_URL   = 'postgresql://u:p@ep-fake-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
process.env.RESEND_API_KEY = 're_test';
process.env.MAIL_FROM      = 'Saad <hello@metaljewel.com>';
process.env.MAIL_TO        = 'saad.shahzad1990@gmail.com';
process.env.SITE_URL       = 'https://metaljewel.com';
process.env.ADMIN_TOKEN    = 'test-token-0123456789';
process.env.IP_SALT        = 'test-salt';

const sent = [];        // Resend payloads
const queries = [];     // SQL the handlers issued
let dbRecent = 0;       // what the rate-limit count returns
let dbDown = false;     // simulate an unreachable database

const okJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    sent.push(JSON.parse(opts.body));
    return okJson({ id: 'stub' });
  }
  if (dbDown) throw new Error('connection refused');
  const q = JSON.parse(opts.body).query || '';
  queries.push(q);
  if (q.includes('count(*)')) {
    return okJson({ command: 'SELECT', fields: [{ name: 'recent', dataTypeID: 23 }], rows: [[dbRecent]], rowCount: 1 });
  }
  if (q.trim().startsWith('select')) {
    return okJson({ command: 'SELECT', fields: [{ name: 'email', dataTypeID: 25 }], rows: [['a@b.co']], rowCount: 1 });
  }
  return okJson({ command: 'INSERT', fields: [], rows: [], rowCount: 1 });
};

const { default: contact } = await import('../api/contact.js');
const { default: exportH } = await import('../api/export.js');

function mkRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => (r.code = c, r);
  r.json = b => (r.body = b, r);
  r.setHeader = (k, v) => (r.headers[k] = v);
  return r;
}
const post = (body, over = {}) =>
  ({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, query: {}, body, ...over });

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name} ${extra}`); fail++; }
};
const reset = () => { sent.length = 0; queries.length = 0; dbRecent = 0; dbDown = false; };

console.log('\ncontact endpoint');

let res = mkRes();
await contact(post({}, { method: 'GET' }), res);
check('rejects GET with 405', res.code === 405, `got ${res.code}`);

for (const [label, value] of [['malformed', 'nope'], ['empty', ''], ['no dot', 'a@b'], ['spaces', 'a b@c.co']]) {
  reset(); res = mkRes();
  await contact(post({ email: value }), res);
  check(`rejects ${label} address`, res.code === 400, `got ${res.code}`);
}

reset(); res = mkRes();
await contact(post({ email: 'bot@spam.com', _gotcha: 'filled' }), res);
check('honeypot returns 200 and sends nothing', res.code === 200 && sent.length === 0, `sent ${sent.length}`);

reset(); res = mkRes();
await contact(post({ email: '  Visitor@Example.COM  ', source: 'contact' }), res);
check('accepts a valid address', res.code === 200 && res.body?.ok === true, `got ${res.code}`);
check('sends exactly two emails', sent.length === 2, `sent ${sent.length}`);
check('writes a row', queries.some(q => q.includes('insert into contacts')), '');
check('notifies Saad', sent.some(m => m.to?.includes('saad.shahzad1990@gmail.com')), '');
check('confirms to the visitor', sent.some(m => m.to?.includes('visitor@example.com')), '');
check('lowercases and trims the address', sent.some(m => m.to?.[0] === 'visitor@example.com'), '');
check('notification replies to the visitor', sent.some(m => m.reply_to === 'visitor@example.com'), '');
check('confirmation has html and text', sent.some(m => m.html && m.text), '');
check('confirmation replies reach Saad',
  sent.some(m => m.html && m.reply_to === 'saad.shahzad1990@gmail.com'), '');

reset(); res = mkRes();
await contact(post(JSON.stringify({ email: 'string@body.dev' })), res);
check('parses a raw string body', res.code === 200 && sent.length === 2, `got ${res.code}/${sent.length}`);

/* ---- rate limiting ---- */
reset(); dbRecent = 4; res = mkRes();
await contact(post({ email: 'fifth@example.com' }), res);
check('lets the 5th submission through', res.code === 200 && sent.length === 2, `got ${res.code}/${sent.length}`);

reset(); dbRecent = 5; res = mkRes();
await contact(post({ email: 'sixth@example.com' }), res);
check('blocks the 6th with 429', res.code === 429, `got ${res.code}`);
check('a blocked request sends no email', sent.length === 0, `sent ${sent.length}`);
check('a blocked request writes no row', !queries.some(q => q.includes('insert into')), '');

reset(); dbRecent = 500; res = mkRes();
await contact(post({ email: 'flood@example.com' }), res);
check('stays blocked under a flood', res.code === 429, `got ${res.code}`);

/* ---- resilience ---- */
reset(); dbDown = true; res = mkRes();
await contact(post({ email: 'dbdown@example.com' }), res);
check('database down: still accepts', res.code === 200, `got ${res.code}`);
check('database down: still emails', sent.length === 2, `sent ${sent.length}`);

console.log('\nexport endpoint');

reset(); res = mkRes();
await exportH({ method: 'GET', headers: {}, query: { token: 'wrong' } }, res);
check('rejects a bad token', res.code === 401, `got ${res.code}`);

reset(); res = mkRes();
await exportH({ method: 'GET', headers: {}, query: {} }, res);
check('rejects a missing token', res.code === 401, `got ${res.code}`);

reset(); res = mkRes();
await exportH({ method: 'GET', headers: {}, query: { token: 'test-token-0123456789x' } }, res);
check('rejects a near-miss token', res.code === 401, `got ${res.code}`);

reset(); res = mkRes();
await exportH({ method: 'POST', headers: {}, query: { token: 'test-token-0123456789' } }, res);
check('rejects non-GET', res.code === 405, `got ${res.code}`);

reset(); res = mkRes();
await exportH({ method: 'GET', headers: {}, query: { token: 'test-token-0123456789' } }, res);
check('accepts the token in a query param', res.code === 200, `got ${res.code}`);

/* sync.py sends it this way, so this path matters most */
reset(); res = mkRes();
await exportH({ method: 'GET', headers: { authorization: 'Bearer test-token-0123456789' }, query: {} }, res);
check('accepts the token in an Authorization header', res.code === 200, `got ${res.code}`);
check('returns the contacts array', Array.isArray(res.body?.contacts), '');
check('sets no-store on the response', res.headers['Cache-Control'] === 'no-store', '');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
