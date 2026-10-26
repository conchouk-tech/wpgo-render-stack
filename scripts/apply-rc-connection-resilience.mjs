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

const serverPath = 'mcp-gateway/server-rc.js';
let server = fs.readFileSync(serverPath, 'utf8');

server = replaceOnce(
  server,
  "import { createAuthCodeStore } from './state-store.js';",
  "import { createAuthCodeStore } from './state-store.js';\nimport { createConnectionStore } from './connection-store.js';",
  'connection-store import'
);

server = replaceOnce(
  server,
  "const key = crypto.createHash('sha256').update(rawSecret).digest();\nconst authCodes = await createAuthCodeStore();",
  "const key = crypto.createHash('sha256').update(rawSecret).digest();\nconst secretFingerprint = crypto.createHash('sha256').update(rawSecret).digest('base64url');\nconst authCodes = await createAuthCodeStore();\nconst connectionStore = await createConnectionStore({ secretFingerprint });",
  'connection-store initialization'
);

server = replaceOnce(
  server,
  "  const ready = authCodes.ready();",
  "  const ready = authCodes.ready() && connectionStore.ready();",
  'health readiness'
);

server = replaceOnce(
  server,
  "    oauth_code_store: authCodes.mode(),\n    oauth_shared_state_required: authCodes.requiresShared(),",
  "    oauth_code_store: authCodes.mode(),\n    connection_state_store: connectionStore.mode(),\n    oauth_shared_state_required: authCodes.requiresShared(),",
  'health connection state'
);

server = replaceOnce(
  server,
  "    mcp_url: mcpUrl,\n    connection_page: `${baseUrl(req)}/connect/wordpress?site=${encodeURIComponent(check.site)}`,",
  "    mcp_url: mcpUrl,\n    status_url: `${baseUrl(req)}/v1/connect/status/${encodeURIComponent(createSiteToken(check.site, rawSecret))}`,\n    connection_page: `${baseUrl(req)}/connect/wordpress?site=${encodeURIComponent(check.site)}`,",
  'site link status URL'
);

const connectRouteMarker = "app.get('/connect/wordpress', connectLimiter, async (req, res) => {";
if (!server.includes("app.get('/v1/connect/status/:siteToken'")) {
  server = replaceOnce(
    server,
    connectRouteMarker,
    `app.get('/v1/connect/status/:siteToken', connectLimiter, async (req, res) => {\n  const site = readSiteToken(req.params.siteToken, rawSecret);\n  if (!site) return res.status(404).json({ ok: false, status: 'invalid_site_link', request_id: req.id });\n  try {\n    const row = await connectionStore.getBySite(site);\n    if (!row) {\n      return res.json({ ok: true, site, status: 'not_connected', connected: false, request_id: req.id });\n    }\n    const refreshExpiry = row.refresh_expires_at ? Date.parse(row.refresh_expires_at) : 0;\n    const connected = row.status === 'connected' && (!refreshExpiry || refreshExpiry > Date.now());\n    return res.json({\n      ok: true, site, connected, status: connected ? 'connected' : row.status,\n      client_name: row.client_name || '', connected_at: row.connected_at || null,\n      last_refresh_at: row.last_refresh_at || null, last_seen_at: row.last_seen_at || null,\n      refresh_expires_at: row.refresh_expires_at || null, request_id: req.id\n    });\n  } catch (error) {\n    console.error(JSON.stringify({ event: 'connection_status_error', request_id: req.id, message: String(error?.message || error).slice(0, 300) }));\n    return res.status(503).json({ ok: false, status: 'temporarily_unavailable', request_id: req.id });\n  }\n});\n\n${connectRouteMarker}`,
    'connect route insertion'
  );
}

const oldTokenBlock = `app.post('/oauth/token', oauthLimiter, async (req, res) => {\n  const issuer = baseUrl(req);\n  const grant = String(req.body?.grant_type || '');\n  const clientId = String(req.body?.client_id || '');\n  const requestedResource = String(req.body?.resource || legacyMcpUrl(req));\n  const resourceInfo = validateResource(requestedResource, issuer);\n  res.set('Cache-Control', 'no-store');\n  if (!clientId || clientId.length > 4096) return res.status(400).json({ error: 'invalid_client' });\n  if (!resourceInfo) return res.status(400).json({ error: 'invalid_target' });\n\n  if (grant === 'authorization_code') {\n    const code = String(req.body?.code || '');\n    const verifier = String(req.body?.code_verifier || '');\n    const redirectUri = String(req.body?.redirect_uri || '');\n    if (!code || code.length > 512 || !validPkceVerifier(verifier) || !validRedirectUri(redirectUri)) {\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    let stored;\n    try { stored = await authCodes.take(code); }\n    catch { return res.status(503).json({ error: 'temporarily_unavailable' }); }\n    const row = stored?.payload ? unseal('wpgocode1', stored.payload) : null;\n    if (!row || stored.expiresAt < Date.now() || row.issuer !== issuer || row.resource !== resourceInfo.resource || row.client_id !== clientId || row.redirect_uri !== redirectUri) {\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');\n    if (!secureEqual(expected, row.code_challenge)) return res.status(400).json({ error: 'invalid_grant' });\n    const now = Math.floor(Date.now() / 1000);\n    const base = {\n      issuer,\n      client_id: clientId,\n      site_url: row.site,\n      username: row.username,\n      password: row.password,\n      resource: resourceInfo.resource,\n      scopes: ['mcp']\n    };\n    return res.json({\n      access_token: seal('wpgoaccess1', { ...base, iat: now, exp: now + 3600 }),\n      token_type: 'Bearer',\n      expires_in: 3600,\n      refresh_token: seal('wpgorefresh1', { ...base, iat: now, exp: now + 86400 * 30 }),\n      scope: 'mcp'\n    });\n  }\n\n  if (grant === 'refresh_token') {\n    const refreshToken = String(req.body?.refresh_token || '');\n    const row = unseal('wpgorefresh1', refreshToken);\n    if (!row || row.issuer !== issuer || row.resource !== resourceInfo.resource || row.client_id !== clientId || !Array.isArray(row.scopes) || !row.scopes.includes('mcp')) {\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    const now = Math.floor(Date.now() / 1000);\n    return res.json({\n      access_token: seal('wpgoaccess1', { ...row, iat: now, exp: now + 3600 }),\n      token_type: 'Bearer',\n      expires_in: 3600,\n      refresh_token: refreshToken,\n      scope: 'mcp'\n    });\n  }\n  return res.status(400).json({ error: 'unsupported_grant_type' });\n});`;

const newTokenBlock = `app.post('/oauth/token', oauthLimiter, async (req, res) => {\n  const issuer = baseUrl(req);\n  const grant = String(req.body?.grant_type || '');\n  const suppliedClientId = String(req.body?.client_id || '');\n  const suppliedResource = String(req.body?.resource || '');\n  res.set('Cache-Control', 'no-store');\n\n  if (grant === 'authorization_code') {\n    if (!suppliedClientId || suppliedClientId.length > 4096) return res.status(400).json({ error: 'invalid_client' });\n    const code = String(req.body?.code || '');\n    const verifier = String(req.body?.code_verifier || '');\n    const redirectUri = String(req.body?.redirect_uri || '');\n    if (!code || code.length > 512 || !validPkceVerifier(verifier) || !validRedirectUri(redirectUri)) {\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    let stored;\n    try { stored = await authCodes.take(code); }\n    catch { return res.status(503).json({ error: 'temporarily_unavailable' }); }\n    const row = stored?.payload ? unseal('wpgocode1', stored.payload) : null;\n    const targetResource = suppliedResource || row?.resource || '';\n    const resourceInfo = validateResource(targetResource, issuer);\n    if (!resourceInfo) return res.status(400).json({ error: 'invalid_target' });\n    if (!row || stored.expiresAt < Date.now() || row.issuer !== issuer || row.resource !== resourceInfo.resource || row.client_id !== suppliedClientId || row.redirect_uri !== redirectUri) {\n      console.warn(JSON.stringify({ event: 'oauth_token_rejected', grant, request_id: req.id, reason: 'authorization_code_binding' }));\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');\n    if (!secureEqual(expected, row.code_challenge)) return res.status(400).json({ error: 'invalid_grant' });\n    const now = Math.floor(Date.now() / 1000);\n    const refreshExp = now + 86400 * 90;\n    const base = {\n      issuer,\n      client_id: suppliedClientId,\n      client_name: String(row.client_name || 'MCP client').slice(0, 120),\n      site_url: row.site,\n      username: row.username,\n      password: row.password,\n      resource: resourceInfo.resource,\n      scopes: ['mcp']\n    };\n    const refreshToken = seal('wpgorefresh1', { ...base, iat: now, exp: refreshExp });\n    await connectionStore.record({\n      site: row.site, client_id: suppliedClientId, client_name: base.client_name, resource: resourceInfo.resource,\n      status: 'connected', connected_at: new Date().toISOString(),\n      refresh_expires_at: new Date(refreshExp * 1000).toISOString()\n    }).catch(error => console.error(JSON.stringify({ event: 'connection_state_record_error', request_id: req.id, message: String(error?.message || error).slice(0, 300) })));\n    console.log(JSON.stringify({ event: 'oauth_token_issued', request_id: req.id, site: row.site, client_name: base.client_name }));\n    return res.json({\n      access_token: seal('wpgoaccess1', { ...base, iat: now, exp: now + 3600 }),\n      token_type: 'Bearer',\n      expires_in: 3600,\n      refresh_token: refreshToken,\n      scope: 'mcp'\n    });\n  }\n\n  if (grant === 'refresh_token') {\n    const refreshToken = String(req.body?.refresh_token || '');\n    const row = unseal('wpgorefresh1', refreshToken);\n    if (!row) {\n      console.warn(JSON.stringify({ event: 'oauth_token_rejected', grant, request_id: req.id, reason: 'invalid_or_expired_refresh_token' }));\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    if (suppliedClientId && (suppliedClientId.length > 4096 || row.client_id !== suppliedClientId)) {\n      console.warn(JSON.stringify({ event: 'oauth_token_rejected', grant, request_id: req.id, reason: 'client_binding' }));\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    const targetResource = suppliedResource || row.resource || '';\n    const resourceInfo = validateResource(targetResource, issuer);\n    if (!resourceInfo || row.issuer !== issuer || row.resource !== resourceInfo.resource || !Array.isArray(row.scopes) || !row.scopes.includes('mcp')) {\n      console.warn(JSON.stringify({ event: 'oauth_token_rejected', grant, request_id: req.id, reason: 'resource_or_scope_binding' }));\n      return res.status(400).json({ error: 'invalid_grant' });\n    }\n    const now = Math.floor(Date.now() / 1000);\n    const refreshExp = now + 86400 * 90;\n    const base = { ...row, client_id: row.client_id, resource: resourceInfo.resource };\n    delete base.iat;\n    delete base.exp;\n    const rotatedRefresh = seal('wpgorefresh1', { ...base, iat: now, exp: refreshExp });\n    await connectionStore.record({\n      site: row.site_url, client_id: row.client_id, client_name: row.client_name || 'MCP client', resource: resourceInfo.resource,\n      status: 'connected', last_refresh_at: new Date().toISOString(),\n      refresh_expires_at: new Date(refreshExp * 1000).toISOString()\n    }).catch(error => console.error(JSON.stringify({ event: 'connection_state_record_error', request_id: req.id, message: String(error?.message || error).slice(0, 300) })));\n    console.log(JSON.stringify({ event: 'oauth_token_refreshed', request_id: req.id, site: row.site_url, client_name: String(row.client_name || 'MCP client').slice(0, 120), client_id_supplied: Boolean(suppliedClientId), resource_supplied: Boolean(suppliedResource) }));\n    return res.json({\n      access_token: seal('wpgoaccess1', { ...base, iat: now, exp: now + 3600 }),\n      token_type: 'Bearer',\n      expires_in: 3600,\n      refresh_token: rotatedRefresh,\n      scope: 'mcp'\n    });\n  }\n  return res.status(400).json({ error: 'unsupported_grant_type' });\n});`;

server = replaceOnce(server, oldTokenBlock, newTokenBlock, 'OAuth token endpoint');

server = replaceOnce(
  server,
  "  req.auth = {\n    token,\n    clientId: row.client_id,\n    scopes: ['mcp'],\n    expiresAt: row.exp,\n    resource: new URL(resourceInfo.resource),\n    resourceMetadataUrl: new URL(metadata)\n  };\n  return next();",
  "  req.auth = {\n    token,\n    clientId: row.client_id,\n    scopes: ['mcp'],\n    expiresAt: row.exp,\n    resource: new URL(resourceInfo.resource),\n    resourceMetadataUrl: new URL(metadata)\n  };\n  void connectionStore.record({\n    site: row.site_url, client_id: row.client_id, client_name: row.client_name || 'MCP client', resource: resourceInfo.resource,\n    status: 'connected', last_seen_at: new Date().toISOString()\n  }).catch(error => console.error(JSON.stringify({ event: 'connection_state_record_error', request_id: req.id, message: String(error?.message || error).slice(0, 300) })));\n  return next();",
  'MCP heartbeat'
);

server = replaceOnce(
  server,
  "    await authCodes.close();\n    process.exit(0);",
  "    await Promise.allSettled([authCodes.close(), connectionStore.close()]);\n    process.exit(0);",
  'connection store shutdown'
);

fs.writeFileSync(serverPath, server);

const e2ePath = 'mcp-gateway/rc-onboarding.e2e.js';
let e2e = fs.readFileSync(e2ePath, 'utf8');
e2e = replaceOnce(
  e2e,
  `const refreshBody = new URLSearchParams({\n  grant_type: 'refresh_token',\n  refresh_token: token.data.refresh_token,\n  client_id: clientId,\n  resource: mcpUrl\n});`,
  `// Deliberately omit client_id and resource. Public OAuth clients are allowed to\n// rely on the bindings already carried by the refresh token, and WPGo must not\n// force a needless reconnect after an access token expires.\nconst refreshBody = new URLSearchParams({\n  grant_type: 'refresh_token',\n  refresh_token: token.data.refresh_token\n});`,
  'refresh-token compatibility test'
);
e2e = replaceOnce(
  e2e,
  "assert.ok(refreshed.data?.access_token);",
  "assert.ok(refreshed.data?.access_token);\nassert.ok(refreshed.data?.refresh_token);\nassert.notEqual(refreshed.data.refresh_token, token.data.refresh_token);",
  'refresh rotation assertions'
);
fs.writeFileSync(e2ePath, e2e);

const wpPath = 'wordpress-plugin/includes/class-wpgo-connect-ai.php';
let wp = fs.readFileSync(wpPath, 'utf8');
wp = replaceOnce(
  wp,
  "\t\treturn $this->connection = array(\n\t\t\t'ok'              => true,\n\t\t\t'mcp_url'         => esc_url_raw( isset( $body['mcp_url'] ) ? $body['mcp_url'] : '' ),\n\t\t\t'connection_page' => esc_url_raw( isset( $body['connection_page'] ) ? $body['connection_page'] : '' ),\n\t\t\t'site_name'       => sanitize_text_field( isset( $body['site_name'] ) ? $body['site_name'] : get_bloginfo( 'name' ) ),\n\t\t\t'request_id'      => sanitize_text_field( isset( $body['request_id'] ) ? $body['request_id'] : '' ),\n\t\t);",
  "\t\t$status_url = esc_url_raw( isset( $body['status_url'] ) ? $body['status_url'] : '' );\n\t\t$ai_status  = array( 'status' => 'not_connected', 'connected' => false );\n\t\tif ( ! empty( $status_url ) ) {\n\t\t\t$status_response = wp_remote_get( $status_url, array( 'timeout' => 8, 'redirection' => 0, 'headers' => array( 'Accept' => 'application/json', 'User-Agent' => 'WPGo-WordPress/' . self::VERSION ) ) );\n\t\t\tif ( ! is_wp_error( $status_response ) && 200 === (int) wp_remote_retrieve_response_code( $status_response ) ) {\n\t\t\t\t$status_body = json_decode( wp_remote_retrieve_body( $status_response ), true );\n\t\t\t\tif ( is_array( $status_body ) ) {\n\t\t\t\t\t$ai_status = array(\n\t\t\t\t\t\t'status'          => sanitize_key( isset( $status_body['status'] ) ? $status_body['status'] : 'not_connected' ),\n\t\t\t\t\t\t'connected'       => ! empty( $status_body['connected'] ),\n\t\t\t\t\t\t'client_name'     => sanitize_text_field( isset( $status_body['client_name'] ) ? $status_body['client_name'] : '' ),\n\t\t\t\t\t\t'connected_at'    => sanitize_text_field( isset( $status_body['connected_at'] ) ? $status_body['connected_at'] : '' ),\n\t\t\t\t\t\t'last_refresh_at' => sanitize_text_field( isset( $status_body['last_refresh_at'] ) ? $status_body['last_refresh_at'] : '' ),\n\t\t\t\t\t\t'last_seen_at'    => sanitize_text_field( isset( $status_body['last_seen_at'] ) ? $status_body['last_seen_at'] : '' ),\n\t\t\t\t\t);\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\n\t\treturn $this->connection = array(\n\t\t\t'ok'              => true,\n\t\t\t'mcp_url'         => esc_url_raw( isset( $body['mcp_url'] ) ? $body['mcp_url'] : '' ),\n\t\t\t'status_url'      => $status_url,\n\t\t\t'ai_status'       => $ai_status,\n\t\t\t'connection_page' => esc_url_raw( isset( $body['connection_page'] ) ? $body['connection_page'] : '' ),\n\t\t\t'site_name'       => sanitize_text_field( isset( $body['site_name'] ) ? $body['site_name'] : get_bloginfo( 'name' ) ),\n\t\t\t'request_id'      => sanitize_text_field( isset( $body['request_id'] ) ? $body['request_id'] : '' ),\n\t\t);",
  'WordPress connection status lookup'
);

wp = replaceOnce(
  wp,
  "\t\t$mcp_url = $connection['mcp_url'];\n\t\techo '<div class=\"wpgo-status\"><strong class=\"wpgo-ok\">✓ ' . esc_html__( 'Site ready for AI connection', 'wpgo' ) . '</strong><br><span class=\"wpgo-note\">' . esc_html( $site_name ) . ' · ' . esc_html( $this->site_url() ) . '</span></div>';",
  "\t\t$mcp_url   = $connection['mcp_url'];\n\t\t$ai_status = isset( $connection['ai_status'] ) && is_array( $connection['ai_status'] ) ? $connection['ai_status'] : array();\n\t\tif ( ! empty( $ai_status['connected'] ) ) {\n\t\t\t$client_name = ! empty( $ai_status['client_name'] ) ? $ai_status['client_name'] : __( 'AI client', 'wpgo' );\n\t\t\techo '<div class=\"wpgo-status\"><strong class=\"wpgo-ok\">✓ ' . esc_html( sprintf( __( '%s connected', 'wpgo' ), $client_name ) ) . '</strong><br><span class=\"wpgo-note\">' . esc_html__( 'WPGo has verified the OAuth token exchange with the AI client.', 'wpgo' ) . '</span></div>';\n\t\t} else {\n\t\t\techo '<div class=\"wpgo-status\"><strong>' . esc_html__( 'WordPress ready — AI connection not yet verified', 'wpgo' ) . '</strong><br><span class=\"wpgo-note\">' . esc_html__( 'This site is ready to connect, but WPGo has not yet seen a completed OAuth token exchange from Claude, ChatGPT or another AI client. WordPress readiness alone does not mean the AI is connected.', 'wpgo' ) . '</span></div>';\n\t\t}",
  'truthful WordPress connection status'
);
fs.writeFileSync(wpPath, wp);

console.log('Applied WPGo RC connection resilience fixes.');
