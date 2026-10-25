import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const configuredFounderHosts = String(process.env.WPGO_FOUNDER_SITE_HOSTS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);
const founderSiteHosts = configuredFounderHosts.length
  ? configuredFounderHosts
  : ['ecozenia.vivaforte.es', 'wpgo.vivaforte.es'];

async function promoteFounderSites() {
  if (!databaseUrl || !founderSiteHosts.length) return;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  try {
    const promoted = await pool.query(
      `UPDATE wpgo_accounts a
       SET is_founder = TRUE, plan = 'founder', updated_at = NOW()
       WHERE EXISTS (
         SELECT 1 FROM wpgo_sites s
         WHERE s.account_id = a.id
           AND LOWER(s.site_host) = ANY($1::text[])
       )
       OR EXISTS (
         SELECT 1 FROM wpgo_usage_events u
         WHERE u.account_id = a.id
           AND LOWER(u.site_host) = ANY($1::text[])
       )`,
      [founderSiteHosts]
    );
    const usageHosts = await pool.query(
      `SELECT COALESCE(NULLIF(LOWER(site_host),''),'[blank]') AS host, COUNT(*)::int AS events
       FROM wpgo_usage_events
       WHERE created_at > NOW()-INTERVAL '24 hours'
       GROUP BY 1 ORDER BY events DESC LIMIT 20`
    );
    const registeredHosts = await pool.query(
      `SELECT LOWER(site_host) AS host, COUNT(*)::int AS sites
       FROM wpgo_sites GROUP BY 1 ORDER BY sites DESC LIMIT 20`
    );
    console.log(JSON.stringify({event:'founder_bootstrap',promoted:promoted.rowCount,founderSiteHosts,usageHosts:usageHosts.rows,registeredHosts:registeredHosts.rows}));
  } finally {
    await pool.end();
  }
}

await promoteFounderSites();
await import('./server-v2.js');
