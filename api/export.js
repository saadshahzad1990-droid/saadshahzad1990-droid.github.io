import { neon } from '@neondatabase/serverless';
import { timingSafeEqual } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);

/* Read-only dump of the contacts table, guarded by ADMIN_TOKEN.
   inbox/sync.py on Saad's machine is the only intended caller. */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supplied = String(
    req.query?.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  );

  if (!tokenOk(supplied)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const contacts = await sql`
      select id, name, email, phone, description,
             source, seen_count, created_at, last_seen_at
      from contacts
      order by created_at desc
    `;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      count: contacts.length,
      exported_at: new Date().toISOString(),
      contacts
    });
  } catch (err) {
    console.error('[export] query failed:', err?.message || err);
    return res.status(500).json({ error: 'Query failed' });
  }
}

function tokenOk(supplied) {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected || expected === 'change-me-to-something-long-and-random') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  /* timingSafeEqual throws on length mismatch, so check that first - the length
     of a rejected guess isn't worth protecting. */
  return a.length === b.length && timingSafeEqual(a, b);
}
