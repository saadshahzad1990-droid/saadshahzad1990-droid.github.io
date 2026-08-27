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
let dbIsNew = true;     // whether the upsert reports a fresh insert
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
  if (q.includes('insert into contacts')) {
    return okJson({ command: 'INSERT', fields: [{ name: 'is_new', dataTypeID: 16 }], rows: [[dbIsNew ? 't' : 'f']], rowCount: 1 });  /* pg sends booleans as t/f */
  }
  return okJson({
    command: 'SELECT',
    fields: [{ name: 'email', dataTypeID: 25 }, { name: 'name', dataTypeID: 25 }],
    rows: [['a@b.co', 'Ada']], rowCount: 1
  });
};

const { default: contact } = await import('../api/contact.js');
const { default: exportH } = await import('../api/export.js');
const { default: unsub, unsubscribeUrl } = await import('../api/unsubscribe.js');

function mkRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => (r.code = c, r);
  r.json = b => (r.body = b, r);
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.send = b => (r.body = b, r);
  return r;
}
const post = (body, over = {}) =>
  ({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, query: {}, body, ...over });

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+49 15123456789',
  description: 'I build analytical engines and would like to talk.',
  source: 'contact'
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name} ${extra}`); fail++; }
};
const reset = () => { sent.length = 0; queries.length = 0; dbRecent = 0; dbIsNew = true; dbDown = false; };
const notif   = () => sent.find(m => m.text && !m.html);
const confirm = () => sent.find(m => m.html);

console.log('\ncontact endpoint — validation');

let res = mkRes();
await contact(post({}, { method: 'GET' }), res);
check('rejects GET with 405', res.code === 405, `got ${res.code}`);

for (const [label, patch] of [
  ['missing name',   { name: '' }],
  ['one-char name',  { name: 'A' }],
  ['missing email',  { email: '' }],
  ['malformed email',{ email: 'nope' }],
  ['email with no dot', { email: 'a@b' }],
  ['too-short phone',{ phone: '+49 12' }],
  ['letters in phone', { phone: '+49 abcdefgh' }],
]) {
  reset(); res = mkRes();
  await contact(post({ ...VALID, ...patch }), res);
  check(`rejects ${label}`, res.code === 400, `got ${res.code} ${JSON.stringify(res.body)}`);
}

reset(); res = mkRes();
await contact(post({ ...VALID, phone: '', description: '' }), res);
check('phone and description are optional', res.code === 200, `got ${res.code}`);

console.log('\ncontact endpoint — a new person');

reset(); res = mkRes();
await contact(post(VALID), res);
check('accepts a full submission', res.code === 200 && res.body?.ok === true, `got ${res.code}`);
check('sends exactly two emails', sent.length === 2, `sent ${sent.length}`);
check('writes one upsert', queries.filter(q => q.includes('insert into contacts')).length === 1, '');
check('notification goes to Saad', notif()?.to?.includes('saad.shahzad1990@gmail.com'), '');
check('notification subject names them', notif()?.subject === 'New contact: Ada Lovelace', notif()?.subject);
check('notification includes the phone', notif()?.text?.includes('+49 15123456789'), '');
check('notification includes the description', notif()?.text?.includes('analytical engines'), '');
check('notification replies to them', notif()?.reply_to === 'ada@example.com', '');
check('confirmation goes to them', confirm()?.to?.includes('ada@example.com'), '');
check('confirmation greets by first name', confirm()?.html?.includes('Thanks, Ada.'), '');
check('confirmation replies reach Saad', confirm()?.reply_to === 'saad.shahzad1990@gmail.com', '');

console.log('\ncontact endpoint — one email per person');

reset(); dbIsNew = false; res = mkRes();
await contact(post(VALID), res);
check('repeat submission sends NOTHING', sent.length === 0, `sent ${sent.length}`);
check('repeat still returns 200', res.code === 200, `got ${res.code}`);
check('repeat still records the visit', queries.some(q => q.includes('insert into contacts')), '');
check('repeat still bumps seen_count', queries.some(q => q.includes('seen_count   = contacts.seen_count + 1')), '');

reset(); dbIsNew = false; res = mkRes();
for (let i = 0; i < 20; i++) { await contact(post(VALID), mkRes()); }
check('twenty repeats send zero emails', sent.length === 0, `sent ${sent.length}`);

console.log('\ncontact endpoint — abuse and failure');

reset(); res = mkRes();
await contact(post({ ...VALID, _gotcha: 'filled' }), res);
check('honeypot returns 200 and sends nothing', res.code === 200 && sent.length === 0, `sent ${sent.length}`);

reset(); dbRecent = 4; res = mkRes();
await contact(post(VALID), res);
check('lets the 5th submission through', res.code === 200 && sent.length === 2, `got ${res.code}/${sent.length}`);

reset(); dbRecent = 5; res = mkRes();
await contact(post(VALID), res);
check('blocks the 6th with 429', res.code === 429, `got ${res.code}`);
check('a blocked request sends no email', sent.length === 0, `sent ${sent.length}`);

reset(); dbDown = true; res = mkRes();
await contact(post(VALID), res);
check('database down: still accepts', res.code === 200, `got ${res.code}`);
check('database down: notifies Saad so the lead survives', !!notif(), '');
check('database down: does NOT email the visitor', !confirm(), '');
check('database down: warns the record was not stored', notif()?.text?.includes('NOT stored'), '');

reset(); res = mkRes();
await contact(post(JSON.stringify(VALID)), res);
check('parses a raw string body', res.code === 200 && sent.length === 2, `got ${res.code}/${sent.length}`);

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

/* sync.py sends it this way, so this path matters most */
reset(); res = mkRes();
await exportH({ method: 'GET', headers: { authorization: 'Bearer test-token-0123456789' }, query: {} }, res);
check('accepts the token in an Authorization header', res.code === 200, `got ${res.code}`);
check('returns the contacts array', Array.isArray(res.body?.contacts), '');
check('selects the new columns', queries.some(q => q.includes('phone') && q.includes('description')), '');
check('sets no-store on the response', res.headers['Cache-Control'] === 'no-store', '');

console.log('\nunsubscribe');

/* The link that goes in every confirmation email */
const goodUrl = unsubscribeUrl('ada@example.com');
const goodTok = new URL(goodUrl).searchParams.get('t');
const otherTok = new URL(unsubscribeUrl('someone-else@example.com')).searchParams.get('t');

reset(); res = mkRes();
await unsub({ method: 'GET', headers: {}, query: { e: 'ada@example.com', t: goodTok } }, res);
check('GET with a valid token shows a confirm page', res.code === 200 && String(res.body).includes('Yes, remove me'), `got ${res.code}`);
check('GET does NOT delete (mail scanners follow links)', !queries.some(q => q.includes('delete from')), '');

reset(); res = mkRes();
await unsub({ method: 'GET', headers: {}, query: { e: 'ada@example.com', t: 'tampered' } }, res);
check('rejects a tampered token', res.code === 400, `got ${res.code}`);

reset(); res = mkRes();
await unsub({ method: 'GET', headers: {}, query: { e: 'ada@example.com', t: otherTok } }, res);
check("rejects another address's token", res.code === 400, `got ${res.code}`);

reset(); res = mkRes();
await unsub({ method: 'GET', headers: {}, query: {} }, res);
check('rejects a missing address', res.code === 400, `got ${res.code}`);

reset(); res = mkRes();
await unsub({ method: 'POST', headers: {}, query: { e: 'ada@example.com', t: goodTok } }, res);
check('POST with a valid token deletes', res.code === 200 && queries.some(q => q.includes('delete from contacts')), `got ${res.code}`);
check('confirms the row is gone', String(res.body).includes('has been deleted'), '');

reset(); res = mkRes();
await unsub({ method: 'POST', headers: {}, query: { e: 'ada@example.com', t: 'nope' } }, res);
check('POST with a bad token deletes nothing', res.code === 400 && !queries.some(q => q.includes('delete from')), `got ${res.code}`);

reset(); res = mkRes();
await unsub({ method: 'PUT', headers: {}, query: { e: 'ada@example.com', t: goodTok } }, res);
check('rejects other methods', res.code === 405, `got ${res.code}`);

console.log('\nunsubscribe reaches the visitor');

reset(); res = mkRes();
await contact(post(VALID), res);
check('confirmation email carries an unsubscribe link', confirm()?.html?.includes('/api/unsubscribe'), '');
check('plain-text version carries it too', confirm()?.text?.includes('/api/unsubscribe'), '');
check('List-Unsubscribe header set', !!confirm()?.headers?.['List-Unsubscribe'], '');
check('one-click header set', confirm()?.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', '');
check("Saad's notification has no unsubscribe link", !notif()?.text?.includes('/api/unsubscribe'), '');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
