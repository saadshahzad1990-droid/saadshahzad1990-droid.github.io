import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);

/* Deliberately loose. Real validation is whether the confirmation email lands. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body  = parseBody(req.body);
  const email = String(body.email || '').trim().toLowerCase();

  /* Honeypot: a bot filled the hidden field. Report success so it stops retrying. */
  if (body._gotcha) return res.status(200).json({ ok: true });

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: "That email doesn't look right." });
  }

  const source = String(body.source || 'contact').slice(0, 60);
  const ipHash = hashIp(req);

  /* Rate limit. This endpoint makes our verified domain send mail to whatever
     address it is handed, so leaving it open turns it into a bombing relay -
     and burns the daily Resend quota. Count recent rows from the same origin
     before adding another. */
  try {
    const [{ recent }] = await sql`
      select count(*)::int as recent
      from contacts
      where ip_hash = ${ipHash}
        and created_at > now() - interval '10 minutes'
    `;
    if (recent >= 5) {
      return res.status(429).json({ error: 'Too many submissions. Try again in a few minutes.' });
    }
  } catch (err) {
    /* Fails open on purpose: if the database is unreachable we would rather take
       the lead than drop it. Losing the limit for that window is the lesser harm. */
    console.error('[contact] rate check failed:', err?.message || err);
  }

  /* Store first. If the address is already known, count the repeat instead of erroring. */
  let stored = true;
  try {
    await sql`
      insert into contacts (email, source, ip_hash)
      values (${email}, ${source}, ${ipHash})
      on conflict (email) do update
        set seen_count   = contacts.seen_count + 1,
            last_seen_at = now()
    `;
  } catch (err) {
    stored = false;
    console.error('[contact] db insert failed:', err?.message || err);
  }

  /* Send both emails regardless. A lead in the inbox beats a row in a table. */
  const [notify, reply] = await Promise.allSettled([
    sendEmail({
      from: process.env.MAIL_FROM,
      to: [process.env.MAIL_TO],
      reply_to: email,
      subject: `New contact: ${email}`,
      text: [
        `${email} left their address on your site.`,
        ``,
        `Source:  ${source}`,
        `Stored:  ${stored ? 'yes' : 'NO - check the database'}`,
        `Time:    ${new Date().toUTCString()}`,
        ``,
        `Reply straight to this email to reach them.`
      ].join('\n')
    }),
    sendEmail({
      from: process.env.MAIL_FROM,
      to: [email],
      /* Nothing receives mail at MAIL_FROM - a verified domain grants sending,
         not a mailbox. Point replies at the inbox that actually exists. */
      reply_to: process.env.MAIL_TO,
      subject: 'Thanks for reaching out',
      html: confirmationEmail(),
      text: confirmationText()
    })
  ]);

  if (notify.status === 'rejected') console.error('[contact] notify failed:', notify.reason?.message);
  if (reply.status  === 'rejected') console.error('[contact] reply failed:',  reply.reason?.message);

  /* The visitor did their part. Don't show them our plumbing problems. */
  return res.status(200).json({ ok: true });
}

function parseBody(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function hashIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  const ip  = String(fwd).split(',')[0].trim() || 'unknown';
  return createHash('sha256')
    .update(ip + (process.env.IP_SALT || 'no-salt-set'))
    .digest('hex')
    .slice(0, 32);
}

async function sendEmail(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return r.json();
}

/* ---- The confirmation the visitor receives ----
   Table layout and inline styles: email clients are twenty years behind browsers.
   System fonts only, because webfonts don't load in most of them. */
function confirmationEmail() {
  const site = process.env.SITE_URL || 'https://metaljewel.com';
  const stack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0B1220;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B1220;padding:40px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#142138;border:1px solid rgba(237,241,248,.10);border-radius:16px;overflow:hidden;">

    <tr><td style="padding:32px 36px 8px;">
      <div style="font:600 20px ${stack};color:#EDF1F8;letter-spacing:-.01em;">Saad<span style="color:#F0BE58;">.</span></div>
    </td></tr>

    <tr><td style="padding:16px 36px 0;">
      <div style="font:600 26px/1.25 ${stack};color:#EDF1F8;letter-spacing:-.02em;">Thanks for reaching out.</div>
    </td></tr>

    <tr><td style="padding:16px 36px 0;">
      <div style="font:400 16px/1.65 ${stack};color:#A7B2C8;">
        I've got your address and I'll be in touch soon &mdash; usually within a day or two.
        <br><br>
        In the meantime, if you want to see what I've been building, everything's on the site.
      </div>
    </td></tr>

    <tr><td style="padding:28px 36px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#E6AE45;border-radius:12px;">
        <a href="${site}" style="display:inline-block;padding:13px 26px;font:600 15px ${stack};color:#161005;text-decoration:none;">Visit the site</a>
      </td></tr></table>
    </td></tr>

    <tr><td style="padding:32px 36px 34px;">
      <div style="height:1px;background:rgba(237,241,248,.10);margin-bottom:20px;"></div>
      <div style="font:400 13px/1.6 ${stack};color:#A7B2C8;">
        Saad &middot; Software Engineering<br>
        University of Europe for Applied Sciences, Potsdam
      </div>
    </td></tr>

  </table>

  <div style="font:400 12px ${stack};color:#5C6880;margin-top:18px;">
    You're getting this because you entered your address at ${site.replace(/^https?:\/\//,'')}.
  </div>
</td></tr>
</table>
</body></html>`;
}

function confirmationText() {
  const site = process.env.SITE_URL || 'https://metaljewel.com';
  return [
    'Thanks for reaching out.',
    '',
    "I've got your address and I'll be in touch soon - usually within a day or two.",
    '',
    `In the meantime, everything I've been building is at ${site}`,
    '',
    '- Saad',
    'Software Engineering, University of Europe for Applied Sciences, Potsdam'
  ].join('\n');
}
