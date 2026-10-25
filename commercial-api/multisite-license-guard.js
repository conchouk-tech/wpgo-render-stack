import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const issueUrl = process.env.WPGO_LICENSE_ISSUE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/admin/license/issue';
const nativeFetch = globalThis.fetch.bind(globalThis);
const pool = databaseUrl ? new Pool({connectionString:databaseUrl,ssl:databaseUrl.includes('localhost')?false:{rejectUnauthorized:false}}) : null;

function sameEndpoint(value) {
  try { return new URL(String(value)).toString() === new URL(issueUrl).toString(); } catch { return false; }
}

if (pool) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    const method = String(init?.method || (typeof input === 'object' ? input?.method : '') || 'GET').toUpperCase();
    if (method === 'POST' && sameEndpoint(url) && typeof init?.body === 'string') {
      try {
        const payload = JSON.parse(init.body);
        const accountId = String(payload?.license_id || '');
        if (/^[0-9a-f-]{36}$/i.test(accountId)) {
          const result = await pool.query(`SELECT site_host FROM wpgo_sites WHERE account_id=$1 ORDER BY connected_at ASC LIMIT 25`, [accountId]);
          const hosts = [...new Set(result.rows.map(r => String(r.site_host || '').trim().toLowerCase()).filter(Boolean))];
          if (hosts.length) init = {...init, body:JSON.stringify({...payload, site_hosts:hosts})};
        }
      } catch (error) {
        console.error(JSON.stringify({event:'multisite_license_guard_error',message:String(error?.message||error).slice(0,300)}));
      }
    }
    return nativeFetch(input, init);
  };
}
