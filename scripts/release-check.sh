#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "WPGo release check FAILED: $*" >&2; exit 1; }
pass() { echo "✓ $*"; }

echo "WPGo 4.5 static commercial-release checks"

echo "Checking Node syntax..."
node --check commercial-api/bootstrap.js
node --check commercial-api/preflight.js
node --check commercial-api/server-v4.js
node --check control-plane/seed-bootstrap.js
node --check control-plane/server-v2.js
node --check portal/app6.js
node --check renderer/server-v3.js
node --check mcp-gateway/server.js
pass "Node syntax"

echo "Checking package metadata..."
node - <<'NODE'
const fs=require('fs');
const expected={
  'commercial-api/package.json':{version:'1.4.1',start:'node bootstrap.js'},
  'control-plane/package.json':{version:'4.5.0',start:'node seed-bootstrap.js'},
  'portal/package.json':{version:'1.6.0',start:'node app6.js'},
  'renderer/package.json':{version:'4.5.0',start:'node server-v3.js'},
  'mcp-gateway/package.json':{version:'1.1.0',start:'node server.js'},
};
for(const [file,want] of Object.entries(expected)){
  const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
  if(pkg.version!==want.version) throw new Error(`${file}: expected version ${want.version}, got ${pkg.version}`);
  if(pkg.scripts?.start!==want.start) throw new Error(`${file}: unexpected start script ${pkg.scripts?.start}`);
}
NODE
pass "Package versions and start commands"

if ! command -v php >/dev/null 2>&1; then
  fail "php CLI is required to lint the WPGo connector patch"
fi
php -l wpgo-plugin-patches/4.5.0/class-wpgo-ai-connector.php >/dev/null
pass "PHP connector syntax"

grep -q "await import('./server-v4.js')" commercial-api/bootstrap.js || fail "commercial bootstrap is not using server-v4.js"
grep -q "await import('./server-v2.js')" control-plane/seed-bootstrap.js || fail "control plane bootstrap is not using server-v2.js"
grep -q '"start": "node app6.js"' portal/package.json || fail "portal is not using app6.js"
grep -q '"start": "node server-v3.js"' renderer/package.json || fail "renderer is not using server-v3.js"
pass "Hardened entrypoints"

if grep -q 'wpgo.vivaforte.es' render.yaml; then
  fail "render.yaml still contains the old test-site hostname"
fi
grep -q 'key: WPGO_DEV_AUTH' render.yaml || fail "WPGO_DEV_AUTH is missing from production blueprint"
grep -A1 'key: WPGO_DEV_AUTH' render.yaml | grep -q 'value: "0"' || fail "WPGO_DEV_AUTH is not disabled"
grep -A1 'key: WPGO_REQUIRE_EMAIL' render.yaml | grep -q 'value: "1"' || fail "production email is not required"
grep -A1 'key: WPGO_REQUIRE_BILLING' render.yaml | grep -q 'value: "1"' || fail "production billing is not required"
grep -q 'key: WPGO_PORTAL_CSRF_SECRET' render.yaml || fail "portal CSRF secret is missing"
grep -A1 'key: WPGO_RENDER_ALLOW_HTTP' render.yaml | grep -q 'value: "0"' || fail "renderer HTTP escape hatch is enabled"
grep -A1 'key: WPGO_RENDER_ALLOW_NO_TOKEN' render.yaml | grep -q 'value: "0"' || fail "renderer no-token escape hatch is enabled"
pass "Production blueprint guardrails"

grep -q "provider_neutral:true" commercial-api/server-v4.js || fail "commercial API does not advertise provider-neutral MCP"
grep -q "provider_neutral_mcp:true" portal/app6.js || fail "portal does not advertise provider-neutral MCP"
grep -q "provider_neutral' => true" wpgo-plugin-patches/4.5.0/class-wpgo-ai-connector.php || fail "plugin connector is not provider-neutral"
grep -q "'agent-connector-for-wp' === \$ns" wpgo-plugin-patches/4.5.0/class-wpgo-ai-connector.php || fail "Agent Connector namespace is not explicitly hidden"
grep -q "site_binding_required" commercial-api/server-v4.js || fail "commercial API does not reject unbound licences"
grep -q "idempotency_key" commercial-api/server-v4.js || fail "usage metering idempotency guard missing"
grep -q "wpgo_webhook_events" commercial-api/server-v4.js || fail "Stripe webhook deduplication table missing"
grep -q "app.post('/connect/confirm',requireCsrf" portal/app6.js || fail "pairing confirmation is not CSRF protected"
if grep -q "document.getElementById('pair').submit" portal/app6.js; then
  fail "portal still auto-submits pairing without explicit user confirmation"
fi
pass "Commercial safety invariants"

if grep -R --line-number --exclude='COMMERCIAL_RELEASE.md' --exclude='README.md' -E 'wpgo-dev-session|WPGO_DEV_AUTH.?=.?(1|true)' commercial-api control-plane portal renderer mcp-gateway 2>/dev/null; then
  fail "development authentication fallback found in production code"
fi
pass "No known development secret fallback"

echo
pass "All static WPGo 4.5 release checks passed"
echo "NOTE: static checks do not replace the end-to-end BLOCKER tests in docs/COMMERCIAL_RELEASE.md."
