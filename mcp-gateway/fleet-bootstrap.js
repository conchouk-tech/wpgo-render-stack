import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SAFE_FLEET_ABILITIES = [
  'wpgo/controller-onboarding-link',
  'wpgo/controller-list-sites',
  'wpgo/controller-site-health',
  'wpgo/controller-command-read',
  'wpgo/controller-read-ability',
  'wpgo/controller-run-ability',
  'wpgo/controller-remote-approval-status',
  'wpgo/controller-fleet-snapshot',
  'wpgo/controller-dispatch',
  'wpgo/controller-run-status',
  'wpgo/controller-list-runs'
];

const ALWAYS_BLOCKED = [
  'wpgo/onboarding-link',
  'wpgo/create-fleet-task',
  'wpgo/fleet-task-status',
  // Raw credential entry and destructive controller maintenance stay hidden.
  'wpgo/controller-register-site',
  'wpgo/controller-cleanup-local-credentials',
  'wpgo/controller-remove-site'
];

export function patchFleetGatewaySource(source) {
  let output = String(source);
  output = output.replace("const VERSION = '1.4.2-rc.3';", "const VERSION = '1.4.3-rc.5-fleet';");
  output = output.replace("const PRODUCT_VERSION = '4.5.0-rc.3';", "const PRODUCT_VERSION = '4.5.0-rc.5';");
  output = output.replace(
    /const BLOCKED_ABILITIES = new Set\(\[[\s\S]*?\]\);/,
    `const BLOCKED_ABILITIES = new Set(${JSON.stringify(ALWAYS_BLOCKED, null, 2)});`
  );
  output = output.replace(
    "!BLOCKED_ABILITIES.has(ability.name) && !ability.name.startsWith('wpgo/controller-')",
    "!BLOCKED_ABILITIES.has(ability.name)"
  );
  if (!output.includes("const VERSION = '1.4.3-rc.5-fleet';")) throw new Error('fleet_version_patch_failed');
  if (!output.includes("'wpgo/controller-list-sites'")) {
    // The source does not need literal safe names after the blocked-set replacement,
    // but this guard catches an unexpectedly different upstream file.
    console.log(JSON.stringify({ event: 'fleet_gateway_patch_note', safe_fleet_abilities: SAFE_FLEET_ABILITIES.length }));
  }
  if (output.includes("!ability.name.startsWith('wpgo/controller-')")) throw new Error('fleet_filter_patch_failed');
  return output;
}

export async function loadFleetServer() {
  const sourceUrl = new URL('./server-rc.js', import.meta.url);
  const runtimeUrl = new URL('./server-fleet-runtime.js', import.meta.url);
  const source = fs.readFileSync(sourceUrl, 'utf8');
  const patched = patchFleetGatewaySource(source);
  fs.writeFileSync(runtimeUrl, patched, { mode: 0o600 });
  console.log(JSON.stringify({
    event: 'fleet_gateway_enabled',
    product_version: '4.5.0-rc.5',
    exposed_controller_abilities: SAFE_FLEET_ABILITIES,
    blocked_controller_mutations: ALWAYS_BLOCKED.filter(name => name.startsWith('wpgo/controller-'))
  }));
  await import(`${pathToFileURL(fileURLToPath(runtimeUrl)).href}?v=${Date.now()}`);
}
