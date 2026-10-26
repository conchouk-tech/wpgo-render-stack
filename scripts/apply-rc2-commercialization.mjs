import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count === 0) {
    if (text.includes(after)) return text;
    throw new Error(`Could not find ${label}`);
  }
  if (count !== 1) throw new Error(`Expected one ${label}, found ${count}`);
  return text.replace(before, after);
}

function replaceRange(text, startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find range ${label}`);
  return text.slice(0, start) + replacement + text.slice(end);
}

// ---- Commercial API: deterministic billing lifecycle + webhook idempotency ----
{
  const path = 'commercial-api/server-v3.js';
  let text = fs.readFileSync(path, 'utf8');
  text = replaceOnce(text, "import Stripe from 'stripe';", "import Stripe from 'stripe';\nimport { billingMutationForEvent } from './billing-lifecycle.js';", 'billing import');
  text = replaceOnce(text, "const VERSION = '1.4.0';", "const VERSION = '1.5.0-rc.2';", 'commercial API version');
  text = replaceOnce(
    text,
    "  await q(`CREATE INDEX IF NOT EXISTS wpgo_support_email_idx ON wpgo_support_tickets(email, created_at DESC)`);",
    "  await q(`CREATE INDEX IF NOT EXISTS wpgo_support_email_idx ON wpgo_support_tickets(email, created_at DESC)`);\n  await q(`CREATE TABLE IF NOT EXISTS wpgo_stripe_events (\n    event_id TEXT PRIMARY KEY,\n    event_type TEXT NOT NULL,\n    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n    processed_at TIMESTAMPTZ\n  )`);\n  await q(`CREATE INDEX IF NOT EXISTS wpgo_stripe_events_received_idx ON wpgo_stripe_events(received_at DESC)`);",
    'stripe event table'
  );
  const webhook = `app.post('/v1/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(503).send('stripe_not_configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', stripeWebhookSecret);
  } catch {
    return res.status(400).send('invalid_signature');
  }

  let claimed = false;
  try {
    const claim = await q(
      \`INSERT INTO wpgo_stripe_events(event_id,event_type) VALUES($1,$2)
       ON CONFLICT(event_id) DO NOTHING RETURNING event_id\`,
      [String(event.id || ''), String(event.type || '')]
    );
    claimed = Boolean(claim.rows[0]);
    if (!claimed) return res.json({ received: true, duplicate: true });

    const mutation = billingMutationForEvent(event);
    if (mutation.kind === 'set_subscription') {
      await q(
        \`UPDATE wpgo_accounts SET plan=$1,stripe_subscription_id=$2,subscription_status=$3,updated_at=NOW()
         WHERE id=$4 AND is_founder=FALSE\`,
        [mutation.plan, mutation.subscription_id, mutation.status, mutation.account_id]
      );
    } else if (mutation.kind === 'cancel_subscription') {
      if (mutation.account_id) {
        await q(
          \`UPDATE wpgo_accounts SET plan='free',stripe_subscription_id=NULL,subscription_status=$1,updated_at=NOW()
           WHERE id=$2 AND is_founder=FALSE\`,
          [mutation.status, mutation.account_id]
        );
      } else if (mutation.subscription_id) {
        await q(
          \`UPDATE wpgo_accounts SET plan='free',stripe_subscription_id=NULL,subscription_status=$1,updated_at=NOW()
           WHERE stripe_subscription_id=$2 AND is_founder=FALSE\`,
          [mutation.status, mutation.subscription_id]
        );
      }
    } else if (mutation.kind === 'set_subscription_status') {
      await q(
        \`UPDATE wpgo_accounts SET subscription_status=$1,updated_at=NOW()
         WHERE stripe_subscription_id=$2 AND is_founder=FALSE\`,
        [mutation.status, mutation.subscription_id]
      );
    }

    await q(\`UPDATE wpgo_stripe_events SET processed_at=NOW() WHERE event_id=$1\`, [String(event.id || '')]);
    console.log(JSON.stringify({ event: 'stripe_webhook_processed', stripe_event: event.type, mutation: mutation.kind }));
    return res.json({ received: true, duplicate: false, mutation: mutation.kind });
  } catch (error) {
    if (claimed) await q(\`DELETE FROM wpgo_stripe_events WHERE event_id=$1 AND processed_at IS NULL\`, [String(event?.id || '')]).catch(() => {});
    console.error(JSON.stringify({ event: 'stripe_webhook_error', type: event?.type || '', message: String(error?.message || error).slice(0, 300) }));
    return res.status(500).send('webhook_processing_failed');
  }
});

`;
  text = replaceRange(text, "app.post('/v1/billing/webhook'", "app.use((err, req, res, next) => {", webhook, 'billing webhook');
  fs.writeFileSync(path, text);
}

// ---- MCP gateway: RC2 version + visible connection history ----
{
  const path = 'mcp-gateway/server-rc.js';
  let text = fs.readFileSync(path, 'utf8');
  text = replaceOnce(text, "const VERSION = '1.4.0-rc.1';", "const VERSION = '1.4.1-rc.2';", 'MCP version');
  text = replaceOnce(text, "const PRODUCT_VERSION = '4.5.0-rc.1';", "const PRODUCT_VERSION = '4.5.0-rc.2';", 'product version');
  text = replaceOnce(text, "    dynamic_client_registration: true", "    dynamic_client_registration: true,\n    connection_history: true", 'connection history health flag');
  text = replaceOnce(
    text,
    "    const row = await connectionStore.getBySite(site);\n    if (!row) {\n      return res.json({ ok: true, site, status: 'not_connected', connected: false, request_id: req.id });\n    }",
    "    const [row, events] = await Promise.all([connectionStore.getBySite(site), connectionStore.getHistory(site)]);\n    if (!row) {\n      return res.json({ ok: true, site, status: 'not_connected', connected: false, events, request_id: req.id });\n    }",
    'status history read'
  );
  text = replaceOnce(
    text,
    "      refresh_expires_at: row.refresh_expires_at || null, request_id: req.id",
    "      refresh_expires_at: row.refresh_expires_at || null, events, request_id: req.id",
    'status history response'
  );
  fs.writeFileSync(path, text);

  const packagePath = 'mcp-gateway/package.json';
  let pkg = fs.readFileSync(packagePath, 'utf8');
  pkg = pkg.replace('"version": "1.4.0-rc.1"', '"version": "1.4.1-rc.2"');
  fs.writeFileSync(packagePath, pkg);

  const startPath = 'mcp-gateway/start.js';
  let start = fs.readFileSync(startPath, 'utf8');
  start = start.replaceAll("1.4.0-rc.1", "1.4.1-rc.2").replaceAll("4.5.0-rc.1", "4.5.0-rc.2");
  fs.writeFileSync(startPath, start);
}

// ---- OAuth regression: connection status and CIMD client metadata ----
{
  const mockPath = 'mcp-gateway/mock-wordpress.js';
  let mock = fs.readFileSync(mockPath, 'utf8');
  const marker = "    if (req.method === 'GET' && (url.pathname === '/wp-json/' || url.pathname === '/wp-json')) {";
  if (!mock.includes("url.pathname === '/client-metadata.json'")) {
    mock = replaceOnce(
      mock,
      marker,
      `    if (req.method === 'GET' && url.pathname === '/client-metadata.json') {\n      return json(res, 200, {\n        client_id: \`${origin}/client-metadata.json\`,\n        client_name: 'WPGo RC CIMD Client',\n        redirect_uris: ['https://client.example.test/cimd/callback'],\n        grant_types: ['authorization_code', 'refresh_token'],\n        response_types: ['code'],\n        token_endpoint_auth_method: 'none'\n      });\n    }\n\n${marker}`,
      'CIMD mock route'
    );
  }
  fs.writeFileSync(mockPath, mock);

  const e2ePath = 'mcp-gateway/rc-onboarding.e2e.js';
  let e2e = fs.readFileSync(e2ePath, 'utf8');
  e2e = replaceOnce(
    e2e,
    "assert.ok(refreshed.data?.refresh_token);\nassert.notEqual(refreshed.data.refresh_token, token.data.refresh_token);",
    "assert.ok(refreshed.data?.refresh_token);\nassert.notEqual(refreshed.data.refresh_token, token.data.refresh_token);\n\nconsole.log('RC E2E: confirming gateway-visible connection state and history');\nconst linkStatus = await request(link.data.status_url);\nassert.equal(linkStatus.response.status, 200, linkStatus.text);\nassert.equal(linkStatus.data?.connected, true);\nassert.match(String(linkStatus.data?.client_name || ''), /WPGo RC E2E Client/);\nassert.ok(Array.isArray(linkStatus.data?.events));\nassert.ok(linkStatus.data.events.some(row => row.type === 'connected'));\nassert.ok(linkStatus.data.events.some(row => row.type === 'token_refreshed'));",
    'connection status assertions'
  );
  const tamperMarker = "console.log('RC E2E: rejecting a tampered site connector URL');";
  if (!e2e.includes("RC E2E: validating CIMD client metadata")) {
    e2e = replaceOnce(
      e2e,
      tamperMarker,
      `console.log('RC E2E: validating CIMD client metadata discovery');\nconst cimdAuthorize = new URL(\`${gateway}/oauth/authorize\`);\ncimdAuthorize.searchParams.set('response_type', 'code');\ncimdAuthorize.searchParams.set('client_id', \`${new URL(site).origin}/client-metadata.json\`);\ncimdAuthorize.searchParams.set('redirect_uri', 'https://client.example.test/cimd/callback');\ncimdAuthorize.searchParams.set('code_challenge', challenge);\ncimdAuthorize.searchParams.set('code_challenge_method', 'S256');\ncimdAuthorize.searchParams.set('resource', mcpUrl);\ncimdAuthorize.searchParams.set('scope', 'mcp');\nconst cimd = await request(cimdAuthorize.toString());\nassert.equal(cimd.response.status, 302, cimd.text);\nassert.equal(new URL(cimd.response.headers.get('location')).pathname, '/wp-admin/authorize-application.php');\n\n${tamperMarker}`,
      'CIMD E2E check'
    );
  }
  e2e = e2e.replace("product_version: '4.5.0-rc.1'", "product_version: '4.5.0-rc.2'");
  fs.writeFileSync(e2ePath, e2e);
}

// ---- Portal: account-side Connect AI + live connection state ----
{
  const path = 'portal/app6.js';
  let text = fs.readFileSync(path, 'utf8');
  text = replaceOnce(text, "const VERSION = '1.6.0';", "const VERSION = '1.7.0-rc.2';", 'portal version');
  text = replaceOnce(
    text,
    "const apiBase = String(process.env.WPGO_COMMERCIAL_API || 'https://wpgo-commercial-api.onrender.com').replace(/\\\/$/, '');",
    "const apiBase = String(process.env.WPGO_COMMERCIAL_API || 'https://wpgo-commercial-api.onrender.com').replace(/\\\/$/, '');\nconst mcpGateway = String(process.env.WPGO_MCP_GATEWAY || 'https://wpgo-mcp-ga.onrender.com').replace(/\\\/$/, '');",
    'portal MCP gateway config'
  );
  text = replaceOnce(
    text,
    "  if (api.protocol !== 'https:') throw new Error('WPGO_COMMERCIAL_API must use HTTPS in production.');\n  if (csrfSecret.length < 32)",
    "  if (api.protocol !== 'https:') throw new Error('WPGO_COMMERCIAL_API must use HTTPS in production.');\n  const gateway = new URL(mcpGateway);\n  if (gateway.protocol !== 'https:') throw new Error('WPGO_MCP_GATEWAY must use HTTPS in production.');\n  if (csrfSecret.length < 32)",
    'portal production gateway validation'
  );
  const helperMarker = "function safeReturn(value) {";
  if (!text.includes('async function gatewayJson(')) {
    text = replaceOnce(
      text,
      helperMarker,
      `async function gatewayJson(urlOrPath) {\n  const url = String(urlOrPath || '').startsWith('https://') ? String(urlOrPath) : \`${mcpGateway}${urlOrPath}\`;\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(), 8_000);\n  try {\n    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error' });\n    const text = await response.text();\n    let data = {};\n    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }\n    return { ok: response.ok, status: response.status, data };\n  } catch (error) {\n    return { ok: false, status: 502, data: { error: 'mcp_gateway_unavailable' } };\n  } finally {\n    clearTimeout(timer);\n  }\n}\n\nasync function siteConnectionState(siteUrl) {\n  const link = await gatewayJson(\`/v1/connect/site-link?site=${encodeURIComponent(siteUrl)}\`);\n  if (!link.ok) return { connected: false, status: 'unavailable', connection_page: '' };\n  const status = link.data.status_url ? await gatewayJson(link.data.status_url) : { ok: false, data: {} };\n  return {\n    connected: Boolean(status.ok && status.data?.connected),\n    status: status.ok ? String(status.data?.status || 'not_connected') : 'unknown',\n    client_name: status.ok ? String(status.data?.client_name || '') : '',\n    last_seen_at: status.ok ? status.data?.last_seen_at || null : null,\n    last_refresh_at: status.ok ? status.data?.last_refresh_at || null : null,\n    connection_page: String(link.data.connection_page || '')\n  };\n}\n\n${helperMarker}`,
      'portal gateway helpers'
    );
  }
  text = replaceOnce(
    text,
    "  const csrf = csrfFor(token);\n  const siteHtml = sites.length\n    ? sites.map(site => `<div class=\"site\"><div><strong>${esc(site.label || site.site_host)}</strong><br><span class=\"small\">${esc(site.site_url || site.site_host)}</span></div><form method=\"post\" action=\"/account/license\"><input type=\"hidden\" name=\"csrf\" value=\"${esc(csrf)}\"><button class=\"btn secondary\">Generate licence</button></form></div>`).join('')\n    : '<p>No sites connected yet.</p>';",
    "  const csrf = csrfFor(token);\n  const states = await Promise.all(sites.map(site => siteConnectionState(site.site_url)));\n  const siteHtml = sites.length\n    ? sites.map((site, index) => {\n        const state = states[index] || { connected: false, status: 'unknown' };\n        const statusLabel = state.connected ? `✓ ${state.client_name || 'AI connected'}` : (state.status === 'unavailable' ? 'Gateway unavailable' : 'AI not connected');\n        const detail = state.last_seen_at ? `Last seen ${new Date(state.last_seen_at).toLocaleString()}` : (state.last_refresh_at ? `Last refresh ${new Date(state.last_refresh_at).toLocaleString()}` : 'No completed AI session recorded');\n        return `<div class=\"site\"><div><strong>${esc(site.label || site.site_host)}</strong><br><span class=\"small\">${esc(site.site_url || site.site_host)}</span><br><span class=\"small\">${esc(statusLabel)} · ${esc(detail)}</span></div><div class=\"choice\"><a class=\"btn\" href=\"/account/sites/connect-ai?site_id=${encodeURIComponent(site.id)}\">Connect AI</a><form method=\"post\" action=\"/account/license\"><input type=\"hidden\" name=\"csrf\" value=\"${esc(csrf)}\"><button class=\"btn secondary\">Licence</button></form></div></div>`;\n      }).join('')\n    : '<p>No sites connected yet.</p>';",
    'portal site connection status'
  );
  const registerRoute = "app.post('/account/sites/register', async (req, res) => {";
  if (!text.includes("app.get('/account/sites/connect-ai'")) {
    text = replaceOnce(
      text,
      registerRoute,
      `app.get('/account/sites/connect-ai', async (req, res) => {\n  const token = cookie(req, SESSION_COOKIE);\n  if (!token) return res.redirect(302, '/start');\n  const sitesResult = await api('/v1/account/sites', { token });\n  if (!sitesResult.ok) return res.redirect(302, '/account?notice=' + encodeURIComponent('Could not load your sites.'));\n  const site = (sitesResult.data.sites || []).find(row => String(row.id) === String(req.query.site_id || ''));\n  if (!site) return res.status(404).send(shell('Connect AI', '<section class=\"section\"><div class=\"card formbox\"><h2>Site not found</h2><p>This site is not registered to your WPGo account.</p></div></section>'));\n  const link = await gatewayJson(\`/v1/connect/site-link?site=${encodeURIComponent(site.site_url)}\`);\n  if (!link.ok || !link.data.connection_page) {\n    return res.redirect(302, '/account?notice=' + encodeURIComponent(link.data?.message || link.data?.error || 'Could not prepare the AI connection.'));\n  }\n  return res.redirect(302, link.data.connection_page);\n});\n\n${registerRoute}`,
      'portal connect AI route'
    );
  }
  text = replaceOnce(text, "  support_centre: true", "  support_centre: true,\n  connect_ai: true,\n  connection_telemetry: true", 'portal health flags');
  fs.writeFileSync(path, text);
}

// ---- WordPress admin: integrate under WPGo menu, show real AI telemetry ----
{
  const path = 'wordpress-plugin/includes/class-wpgo-connect-ai.php';
  let text = fs.readFileSync(path, 'utf8');
  text = text.replace("const VERSION = '4.5.0-rc.1';", "const VERSION = '4.5.0-rc.2';");
  text = replaceOnce(
    text,
    "\tpublic function register_menu() {\n\t\t$parent = apply_filters( 'wpgo_connect_ai_parent_slug', 'tools.php' );",
    "\tprivate function parent_menu_slug() {\n\t\t$preferred = apply_filters( 'wpgo_connect_ai_parent_slug', '' );\n\t\tif ( ! empty( $preferred ) ) {\n\t\t\treturn $preferred;\n\t\t}\n\t\tglobal $menu;\n\t\tforeach ( (array) $menu as $item ) {\n\t\t\t$slug = isset( $item[2] ) ? (string) $item[2] : '';\n\t\t\tif ( in_array( $slug, array( 'wpgo', 'wpgo-dashboard', 'wpgo-settings' ), true ) ) {\n\t\t\t\treturn $slug;\n\t\t\t}\n\t\t}\n\t\treturn 'tools.php';\n\t}\n\n\tprivate function page_url() {\n\t\t$parent = $this->parent_menu_slug();\n\t\treturn 'tools.php' === $parent ? admin_url( 'tools.php?page=' . self::PAGE_SLUG ) : admin_url( 'admin.php?page=' . self::PAGE_SLUG );\n\t}\n\n\tpublic function register_menu() {\n\t\t$parent = $this->parent_menu_slug();",
    'WordPress parent menu integration'
  );
  text = replaceOnce(
    text,
    "\t\t\t\t\t\t'last_seen_at'    => sanitize_text_field( isset( $status_body['last_seen_at'] ) ? $status_body['last_seen_at'] : '' ),",
    "\t\t\t\t\t\t'last_seen_at'       => sanitize_text_field( isset( $status_body['last_seen_at'] ) ? $status_body['last_seen_at'] : '' ),\n\t\t\t\t\t\t'refresh_expires_at' => sanitize_text_field( isset( $status_body['refresh_expires_at'] ) ? $status_body['refresh_expires_at'] : '' ),\n\t\t\t\t\t\t'events'             => isset( $status_body['events'] ) && is_array( $status_body['events'] ) ? array_slice( $status_body['events'], 0, 8 ) : array(),",
    'WordPress status telemetry'
  );
  text = replaceOnce(
    text,
    "\t\twp_safe_redirect( admin_url( 'tools.php?page=' . self::PAGE_SLUG . '&refreshed=1' ) );",
    "\t\twp_safe_redirect( add_query_arg( 'refreshed', '1', $this->page_url() ) );",
    'WordPress refresh URL'
  );
  const statusEnd = "\t\techo '<div class=\"wpgo-grid\">';";
  if (!text.includes('Recent connection activity')) {
    text = replaceOnce(
      text,
      statusEnd,
      `\t\t$events = isset( $ai_status['events'] ) && is_array( $ai_status['events'] ) ? $ai_status['events'] : array();\n\t\tif ( ! empty( $ai_status['last_seen_at'] ) || ! empty( $ai_status['last_refresh_at'] ) || ! empty( $ai_status['refresh_expires_at'] ) ) {\n\t\t\techo '<div class="wpgo-card" style="margin-top:14px"><h2>' . esc_html__( 'Connection health', 'wpgo' ) . '</h2>';\n\t\t\tif ( ! empty( $ai_status['last_seen_at'] ) ) echo '<p><strong>' . esc_html__( 'Last AI activity:', 'wpgo' ) . '</strong> ' . esc_html( $ai_status['last_seen_at'] ) . '</p>';\n\t\t\tif ( ! empty( $ai_status['last_refresh_at'] ) ) echo '<p><strong>' . esc_html__( 'Last OAuth refresh:', 'wpgo' ) . '</strong> ' . esc_html( $ai_status['last_refresh_at'] ) . '</p>';\n\t\t\tif ( ! empty( $ai_status['refresh_expires_at'] ) ) echo '<p><strong>' . esc_html__( 'Refresh credential expiry:', 'wpgo' ) . '</strong> ' . esc_html( $ai_status['refresh_expires_at'] ) . '</p>';\n\t\t\techo '</div>';\n\t\t}\n\t\tif ( ! empty( $events ) ) {\n\t\t\techo '<div class="wpgo-card" style="margin-top:14px"><h2>' . esc_html__( 'Recent connection activity', 'wpgo' ) . '</h2>';\n\t\t\tforeach ( $events as $event ) {\n\t\t\t\t$type = sanitize_text_field( isset( $event['type'] ) ? $event['type'] : 'activity' );\n\t\t\t\t$time = sanitize_text_field( isset( $event['time'] ) ? $event['time'] : '' );\n\t\t\t\techo '<p><strong>' . esc_html( $type ) . '</strong>' . ( $time ? ' · ' . esc_html( $time ) : '' ) . '</p>';\n\t\t\t}\n\t\t\techo '</div>';\n\t\t}\n${statusEnd}`,
      'WordPress connection history UI'
    );
  }
  fs.writeFileSync(path, text);

  const pluginPath = 'wordpress-plugin/wpgo-connect-ai-rc.php';
  let plugin = fs.readFileSync(pluginPath, 'utf8');
  plugin = plugin.replaceAll('4.5.0-rc.1', '4.5.0-rc.2');
  fs.writeFileSync(pluginPath, plugin);
}

// ---- Renderer: safe screenshot + page audit endpoint ----
{
  const path = 'renderer/server.js';
  let text = fs.readFileSync(path, 'utf8');
  text = replaceOnce(text, "const VERSION = '4.3.0';", "const VERSION = '4.4.0-rc.2';", 'renderer version');
  text = replaceOnce(
    text,
    "    max_concurrency: maxConcurrency",
    "    max_concurrency: maxConcurrency,\n    screenshot: true,\n    site_audit: true",
    'renderer capabilities'
  );
  const shutdownMarker = "let shuttingDown = false;";
  if (!text.includes("app.post('/v1/site-audit'")) {
    const auditRoute = `app.post('/v1/site-audit', renderLimiter, async (req, res) => {\n  const requestId = crypto.randomUUID();\n  res.set('X-WPGo-Request-ID', requestId);\n  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized', request_id: requestId });\n  if (active >= maxConcurrency) return res.status(429).json({ error: 'busy', retry_after_seconds: 2, request_id: requestId });\n  const url = await validateUrl(req.body?.url, { main: true });\n  if (!url) return res.status(400).json({ error: 'invalid_or_disallowed_url', request_id: requestId });\n  const waitMs = Math.max(0, Math.min(5000, Number(req.body?.wait_ms || 800)));\n  const includeScreenshot = req.body?.screenshot === true;\n  const fullPage = req.body?.full_page === true;\n  const started = Date.now();\n  active += 1;\n  let context;\n  try {\n    const currentBrowser = await getBrowser();\n    context = await currentBrowser.newContext({\n      javaScriptEnabled: true, ignoreHTTPSErrors: false, serviceWorkers: 'block',\n      viewport: { width: 1365, height: 768 }\n    });\n    const page = await context.newPage();\n    const consoleErrors = [];\n    page.on('console', message => { if (message.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(message.text().slice(0, 500)); });\n    await page.route('**/*', async route => {\n      const request = route.request();\n      if (['media', 'font', 'websocket'].includes(request.resourceType())) return route.abort();\n      const target = await validateUrl(request.url(), { main: false });\n      if (!target) return route.abort('blockedbyclient');\n      return route.continue();\n    });\n    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });\n    if (waitMs) await page.waitForTimeout(waitMs);\n    const finalUrl = page.url();\n    if (!await validateUrl(finalUrl, { main: true })) throw new Error('Final navigation URL failed WPGo public-network policy.');\n    const audit = await page.evaluate(() => {\n      const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 40).map(node => ({ level: node.tagName.toLowerCase(), text: (node.textContent || '').trim().slice(0, 240) }));\n      const images = [...document.images];\n      const links = [...document.querySelectorAll('a[href]')];\n      return {\n        title: document.title || '',\n        meta_description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',\n        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',\n        headings,\n        h1_count: document.querySelectorAll('h1').length,\n        image_count: images.length,\n        images_missing_alt: images.filter(img => !img.hasAttribute('alt') || !(img.getAttribute('alt') || '').trim()).length,\n        link_count: links.length,\n        form_count: document.forms.length,\n        lang: document.documentElement.lang || '',\n        text_length: (document.body?.innerText || '').length\n      };\n    });\n    const screenshotBase64 = includeScreenshot\n      ? (await page.screenshot({ type: 'png', fullPage })).toString('base64')\n      : '';\n    return res.json({\n      ok: true, request_id: requestId, final_url: finalUrl, http_status: response?.status() || 0,\n      ...audit, console_errors: consoleErrors, screenshot_png_base64: screenshotBase64,\n      timings: { total_ms: Date.now() - started }\n    });\n  } catch (error) {\n    console.error(JSON.stringify({ event: 'site_audit_failed', request_id: requestId, message: String(error?.message || error).slice(0, 300) }));\n    return res.status(502).json({ error: 'site_audit_failed', request_id: requestId });\n  } finally {\n    active -= 1;\n    if (context) await context.close().catch(() => {});\n  }\n});\n\n`;
    text = replaceOnce(text, shutdownMarker, auditRoute + shutdownMarker, 'renderer audit route');
  }
  fs.writeFileSync(path, text);
}

// ---- Production Blueprint: expose gateway to account portal without changing plans ----
{
  const path = 'render.yaml';
  let text = fs.readFileSync(path, 'utf8');
  const marker = "      - key: WPGO_COMMERCIAL_API\n        value: \"https://wpgo-commercial-api.onrender.com\"";
  const replacement = marker + "\n      - key: WPGO_MCP_GATEWAY\n        value: \"https://wpgo-mcp-ga.onrender.com\"";
  text = replaceOnce(text, marker, replacement, 'portal MCP gateway env');
  fs.writeFileSync(path, text);
}

console.log(JSON.stringify({ event: 'wpgo_rc2_commercialization_patch', ok: true }));
