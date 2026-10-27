import './outbound-guard.js';
import './agent-experience-proxy.js';
import { loadFleetServer } from './fleet-bootstrap.js';

await loadFleetServer();

const port = Number(process.env.PORT || 8095);
const local = `http://127.0.0.1:${port}`;

async function startupCheck() {
  try {
    const response = await fetch(`${local}/health`, { redirect: 'manual' });
    const data = await response.json();
    const ok = response.ok && data?.ok === true && data?.product_version === '4.5.0-rc.5';
    console.log(JSON.stringify({
      event: 'wpgo_mcp_fleet_self_test',
      ok,
      version: data?.version || '',
      product_version: data?.product_version || '',
      approval_proxy: data?.approval_proxy === true,
      site_specific_mcp_urls: data?.site_specific_mcp_urls === true
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'wpgo_mcp_fleet_self_test',
      ok: false,
      error: String(error?.message || error).slice(0, 300)
    }));
  }
}

setTimeout(() => void startupCheck(), 1400);
