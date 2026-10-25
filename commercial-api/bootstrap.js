const nodeEnv = String(process.env.NODE_ENV || 'production').toLowerCase();

if (nodeEnv === 'production' && process.env.WPGO_DEV_AUTH === '1') {
  console.error(JSON.stringify({event:'startup_config_invalid',error:'WPGO_DEV_AUTH must be disabled in production'}));
  process.exit(1);
}

const { runCommercialPreflight } = await import('./preflight.js');
await runCommercialPreflight();
await import('./server-v4.js');
