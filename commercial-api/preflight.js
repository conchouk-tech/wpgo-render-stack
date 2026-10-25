import pg from 'pg';

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || '');

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}
function hostFromSiteUrl(value) {
  try { return normalizeHost(new URL(String(value || '')).hostname); } catch { return ''; }
}

export async function runCommercialPreflight() {
  if (!databaseUrl) return;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 8000,
  });
  const client = await pool.connect();
  try {
    const exists = await client.query(`SELECT to_regclass('public.wpgo_sites') AS table_name`);
    if (!exists.rows[0]?.table_name) return;

    await client.query('BEGIN');
    const rows = await client.query(`SELECT id, account_id, site_url, site_host, connected_at FROM wpgo_sites ORDER BY connected_at DESC`);
    const groups = new Map();
    for (const row of rows.rows) {
      const normalized = hostFromSiteUrl(row.site_url) || normalizeHost(row.site_host);
      if (!normalized) continue;
      const key = `${row.account_id}|${normalized}`;
      const current = groups.get(key) || [];
      current.push({ ...row, normalized });
      groups.set(key, current);
    }

    let normalizedRows = 0;
    let duplicateRows = 0;
    for (const group of groups.values()) {
      const exact = group.find(row => String(row.site_host || '').toLowerCase() === row.normalized);
      const keep = exact || group[0];
      const remove = group.filter(row => row.id !== keep.id);
      if (remove.length) {
        await client.query(`DELETE FROM wpgo_sites WHERE id = ANY($1::uuid[])`, [remove.map(row => row.id)]);
        duplicateRows += remove.length;
      }
      if (keep.site_host !== keep.normalized) {
        await client.query(`UPDATE wpgo_sites SET site_host=$1 WHERE id=$2`, [keep.normalized, keep.id]);
        normalizedRows += 1;
      }
    }
    await client.query('COMMIT');
    if (normalizedRows || duplicateRows) {
      console.log(JSON.stringify({ event:'site_host_migration', normalized_rows:normalizedRows, duplicate_rows_removed:duplicateRows }));
    }
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
