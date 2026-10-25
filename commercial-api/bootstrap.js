import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const founderSiteHosts = String(process.env.WPGO_FOUNDER_SITE_HOSTS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

async function promoteFounderSites() {
  if (!databaseUrl || !founderSiteHosts.length) return;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  try {
    await pool.query(
      `UPDATE wpgo_accounts a
       SET is_founder = TRUE, plan = 'founder', updated_at = NOW()
       WHERE EXISTS (
         SELECT 1 FROM wpgo_sites s
         WHERE s.account_id = a.id
           AND LOWER(s.site_host) = ANY($1::text[])
       )`,
      [founderSiteHosts]
    );
  } finally {
    await pool.end();
  }
}

await promoteFounderSites();
await import('./server-v2.js');
