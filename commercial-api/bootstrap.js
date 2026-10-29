import pg from 'pg';
import fs from 'node:fs/promises';
import './runtime-readiness.js';
import { WPGoPricing } from '../pricing-config.js';
await import('./stripe-runtime-check.js');

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
    console.log(JSON.stringify({event:'founder_bootstrap',promoted:promoted.rowCount,host_count:founderSiteHosts.length}));
  } finally {
    await pool.end();
  }
}

async function importCommercialServer() {
  const sourceUrl = new URL('./server-v2.js', import.meta.url);
  const runtimeUrl = new URL('./.wpgo-server-v2-runtime.mjs', import.meta.url);
  let source = await fs.readFile(sourceUrl, 'utf8');
  const replacements = [
    ['yearly_eur:60.69', `yearly_eur:${WPGoPricing.solo.yearly}`],
    ['yearly_eur:132.09', `yearly_eur:${WPGoPricing.pro.yearly}`],
    ['yearly_eur:254.49', `yearly_eur:${WPGoPricing.agency.yearly}`],
    ['yearly_eur:407.49', `yearly_eur:${WPGoPricing.scale.yearly}`]
  ];
  for (const [from, to] of replacements) source = source.split(from).join(to);
  await fs.writeFile(runtimeUrl, source, 'utf8');
  await import(`${runtimeUrl.href}?v=${Date.now()}`);
}

await promoteFounderSites();
await import('./multisite-license-guard.js');
const loginEmail = await import('./login-email-route.js');
loginEmail.installLoginEmailRouteGuard();
await importCommercialServer();
loginEmail.restoreLoginEmailRouteGuard();
