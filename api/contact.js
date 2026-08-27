import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { unsubscribeUrl } from './unsubscribe.js';

const sql = neon(process.env.DATABASE_URL);

/* Deliberately loose. Real validation is whether the confirmation email lands. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_NAME = 100;
const MAX_PHONE = 25;
const MAX_DESC = 1500;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req.body);

  /* Honeypot: a bot filled the hidden field. Report success so it stops retrying. */
  if (body._gotcha) return res.status(200).json({ ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  const name  = String(body.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(body.phone || '').trim();
  const description = String(body.description || '').trim().slice(0, MAX_DESC);

  if (name.length < 2 || name.length > MAX_NAME) {
    return res.status(400).json({ error: 'Please give a name between 2 and 100 characters.' });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: "That email doesn't look right." });
  }
  if (phone) {
    const digits = phone.replace(/[^0-9]/g, '');
    if (phone.length > MAX_PHONE || digits.length < 5 || digits.length > 17) {
      return res.status(400).json({ error: 'That phone number looks incomplete.' });
    }
  }

  const source = String(body.source || 'contact').slice(0, 60);
  const ipHash = hashIp(req);

  /* Rate limit. This endpoint makes our verified domain send mail, so leaving it
     open turns it into a bombing relay - and burns the daily Resend quota.
     Count recent rows from the same origin before adding another. */
  let dbUp = true;
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
    dbUp = false;
    console.error('[contact] rate check failed:', err?.message || err);
  }

  /* One row per address. A repeat submission bumps the counter and refreshes any
     field they filled in this time, rather than creating a duplicate.

     `xmax = 0` is true only for a genuine insert, false when the conflict clause
     fired. That is what tells us whether this person is new - which decides
     whether any mail goes out at all. */
  let isNew = false;
  try {
    const [row] = await sql`
      insert into contacts (email, name, phone, description, source, ip_hash)
      values (${email}, ${name}, ${phone || null}, ${description || null}, ${source}, ${ipHash})
      on conflict (email) do update
        set seen_count   = contacts.seen_count + 1,
            last_seen_at = now(),
            name         = coalesce(nullif(excluded.name, ''), contacts.name),
            phone        = coalesce(excluded.phone, contacts.phone),
            description  = coalesce(excluded.description, contacts.description)
      returning (xmax = 0) as is_new
    `;
    isNew = row.is_new;
  } catch (err) {
    dbUp = false;
    console.error('[contact] db write failed:', err?.message || err);
  }

  /* The whole point of the dedupe: one person, one email, ever. A repeat
     submission is stored silently.

     If the database is unreachable we cannot tell new from repeat. In that case
     the notification still goes out - a lost lead is unrecoverable, a duplicate
     notification is a mild annoyance - but the confirmation does not, because
     that is the one an attacker could aim at somebody else's inbox. */
  const notify = !dbUp || isNew;
  const confirm = dbUp && isNew;

  const jobs = [];
  if (notify) {
    jobs.push(['notify', sendEmail({
      from: process.env.MAIL_FROM,
      to: [process.env.MAIL_TO],
      reply_to: email,
      subject: `New contact: ${name}`,
      text: notificationText({ name, email, phone, description, source, dbUp })
    })]);
  }
  if (confirm) {
    const unsub = unsubscribeUrl(email);
    jobs.push(['confirm', sendEmail({
      from: process.env.MAIL_FROM,
      to: [email],
      /* Nothing receives mail at MAIL_FROM - a verified domain grants sending,
         not a mailbox. Point replies at the inbox that actually exists. */
      reply_to: process.env.MAIL_TO,
      subject: 'Thanks for reaching out',
      html: confirmationEmail(name, unsub),
      text: confirmationText(name, unsub),
      /* RFC 8058. Gmail and Outlook render their own one-click unsubscribe
         button from these, which keeps complaints off the spam button. */
      headers: {
        'List-Unsubscribe': `<${unsub}>, <mailto:${process.env.MAIL_TO}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    })]);
  }

  const results = await Promise.allSettled(jobs.map(j => j[1]));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[contact] ${jobs[i][0]} failed:`, r.reason?.message || r.reason);
    }
  });

  /* The visitor did their part. Don't show them our plumbing problems, and
     don't tell them whether we recognised their address. */
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

/* ---- What Saad receives ---- */
function notificationText({ name, email, phone, description, source, dbUp }) {
  const lines = [
    `${name} got in touch through your site.`,
    ``,
    `Name:   ${name}`,
    `Email:  ${email}`,
    `Phone:  ${phone || '(not given)'}`,
    ``,
    `About them:`,
    description ? indent(description) : `  (nothing written)`,
    ``,
    `---`,
    `Source: ${source}`,
    `Time:   ${new Date().toUTCString()}`
  ];
  if (!dbUp) {
    lines.push(
      ``,
      `WARNING: the database was unreachable, so this submission was NOT stored.`,
      `This email is the only record of it.`
    );
  }
  lines.push(``, `Reply straight to this email to reach them.`);
  return lines.join('\n');
}

function indent(text) {
  return text.split('\n').map(l => '  ' + l).join('\n');
}

/* ---- What the visitor receives ----
   Table layout and inline styles: email clients are twenty years behind browsers.
   System fonts only, because webfonts don't load in most of them. */
function confirmationEmail(name, unsubUrl) {
  const site = process.env.SITE_URL || 'https://metaljewel.com';
  const stack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const first = escapeHtml(firstName(name));
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0B1220;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B1220;padding:40px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#142138;border:1px solid rgba(237,241,248,.10);border-radius:16px;overflow:hidden;">

    <tr><td style="padding:32px 36px 8px;">
      <div style="font:600 20px ${stack};color:#EDF1F8;letter-spacing:-.01em;">Saad<span style="color:#F0BE58;">.</span></div>
    </td></tr>

    <tr><td style="padding:16px 36px 0;">
      <div style="font:600 26px/1.25 ${stack};color:#EDF1F8;letter-spacing:-.02em;">Thanks, ${first}.</div>
    </td></tr>

    <tr><td style="padding:16px 36px 0;">
      <div style="font:400 16px/1.65 ${stack};color:#A7B2C8;">
        I've got your message and I'll be in touch soon &mdash; usually within a day or two.
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

  <div style="font:400 12px/1.7 ${stack};color:#5C6880;margin-top:18px;">
    You're getting this because you filled in the contact form at ${site.replace(/^https?:\/\//, '')}.<br>
    <a href="${unsubUrl}" style="color:#5C6880;text-decoration:underline;">Unsubscribe and delete my details</a>
  </div>
</td></tr>
</table>
</body></html>`;
}

function confirmationText(name, unsubUrl) {
  const site = process.env.SITE_URL || 'https://metaljewel.com';
  return [
    `Thanks, ${firstName(name)}.`,
    '',
    "I've got your message and I'll be in touch soon - usually within a day or two.",
    '',
    `In the meantime, everything I've been building is at ${site}`,
    '',
    '- Saad',
    'Software Engineering, University of Europe for Applied Sciences, Potsdam',
    '',
    'Do not want these? Unsubscribe and delete your details:',
    unsubUrl
  ].join('\n');
}

function firstName(name) {
  return String(name || '').trim().split(' ')[0] || 'there';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
