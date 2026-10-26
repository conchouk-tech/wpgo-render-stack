import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const gateway = String(process.env.WPGO_E2E_GATEWAY || 'http://127.0.0.1:8095').replace(/\/$/, '');
const site = String(process.env.WPGO_E2E_WORDPRESS || 'https://127.0.0.1:9443/');
const redirectUri = 'https://client.example.test/oauth/callback';
const verifier = 'wpgo-rc-e2e-verifier-012345678901234567890123456789';
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', ...options });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { response, text, data };
}

async function jsonPost(url, body, headers = {}) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

console.log('RC E2E: requesting a site-specific MCP link');
const link = await request(`${gateway}/v1/connect/site-link?site=${encodeURIComponent(site)}`);
assert.equal(link.response.status, 200, link.text);
assert.equal(link.data?.ok, true);
assert.equal(link.data?.site, site);
assert.match(link.data?.mcp_url || '', /\/mcp\/s\/wpgosite1\./);
const mcpUrl = link.data.mcp_url;
const mcpPath = new URL(mcpUrl).pathname;

console.log('RC E2E: validating path-aware protected-resource metadata');
const metadata = await request(`${gateway}/.well-known/oauth-protected-resource${mcpPath}`);
assert.equal(metadata.response.status, 200, metadata.text);
assert.equal(metadata.data?.resource, mcpUrl);
assert.deepEqual(metadata.data?.authorization_servers, [gateway]);

console.log('RC E2E: validating site-bound unauthenticated MCP challenge');
const unauthenticated = await jsonPost(mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
  accept: 'application/json, text/event-stream'
});
assert.equal(unauthenticated.response.status, 401, unauthenticated.text);
assert.match(String(unauthenticated.response.headers.get('www-authenticate') || ''), new RegExp(`oauth-protected-resource${mcpPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

console.log('RC E2E: registering a generic OAuth client');
const registration = await jsonPost(`${gateway}/oauth/register`, {
  client_name: 'WPGo RC E2E Client',
  application_type: 'web',
  redirect_uris: [redirectUri],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
});
assert.equal(registration.response.status, 201, registration.text);
const clientId = registration.data?.client_id;
assert.ok(clientId);

console.log('RC E2E: verifying site-specific authorization skips manual site entry');
const authorize = new URL(`${gateway}/oauth/authorize`);
authorize.searchParams.set('response_type', 'code');
authorize.searchParams.set('client_id', clientId);
authorize.searchParams.set('redirect_uri', redirectUri);
authorize.searchParams.set('code_challenge', challenge);
authorize.searchParams.set('code_challenge_method', 'S256');
authorize.searchParams.set('resource', mcpUrl);
authorize.searchParams.set('scope', 'mcp');
authorize.searchParams.set('state', 'rc-e2e-state');
const authorization = await request(authorize.toString());
assert.equal(authorization.response.status, 302, authorization.text);
const wordpressApprovalUrl = authorization.response.headers.get('location');
assert.ok(wordpressApprovalUrl);
assert.equal(new URL(wordpressApprovalUrl).origin, new URL(site).origin);
assert.equal(new URL(wordpressApprovalUrl).pathname, '/wp-admin/authorize-application.php');
assert.ok(new URL(wordpressApprovalUrl).searchParams.get('success_url'));

console.log('RC E2E: simulating WordPress Application Password approval callback');
const successUrl = new URL(new URL(wordpressApprovalUrl).searchParams.get('success_url'));
successUrl.searchParams.set('site_url', site);
successUrl.searchParams.set('user_login', 'rc-admin');
successUrl.searchParams.set('password', 'rc-app-password-0123456789-abcdefghijklmnopqrstuvwxyz');
const callback = await request(successUrl.toString());
assert.equal(callback.response.status, 302, callback.text);
const clientCallback = new URL(callback.response.headers.get('location'));
assert.equal(clientCallback.origin, new URL(redirectUri).origin);
assert.equal(clientCallback.pathname, new URL(redirectUri).pathname);
assert.equal(clientCallback.searchParams.get('state'), 'rc-e2e-state');
assert.equal(clientCallback.searchParams.get('iss'), gateway);
const code = clientCallback.searchParams.get('code');
assert.ok(code);

console.log('RC E2E: exchanging code for site-bound tokens');
const tokenBody = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  client_id: clientId,
  redirect_uri: redirectUri,
  code_verifier: verifier,
  resource: mcpUrl
});
const token = await request(`${gateway}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: tokenBody.toString()
});
assert.equal(token.response.status, 200, token.text);
assert.ok(token.data?.access_token);
assert.ok(token.data?.refresh_token);
assert.equal(token.data?.scope, 'mcp');

console.log('RC E2E: listing WordPress tools over authenticated MCP');
const tools = await jsonPost(mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token.data.access_token}`
});
assert.equal(tools.response.status, 200, tools.text);
assert.match(tools.text, /wpgo__site-info/);
assert.match(tools.text, /wpgo__create-draft-post/);
assert.match(tools.text, /wpgo__approval_status/);

console.log('RC E2E: validating refresh-token rotation path');
// Deliberately omit client_id and resource. Public OAuth clients are allowed to
// rely on the bindings already carried by the refresh token, and WPGo must not
// force a needless reconnect after an access token expires.
const refreshBody = new URLSearchParams({
  grant_type: 'refresh_token',
  refresh_token: token.data.refresh_token
});
const refreshed = await request(`${gateway}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: refreshBody.toString()
});
assert.equal(refreshed.response.status, 200, refreshed.text);
assert.ok(refreshed.data?.access_token);
assert.ok(refreshed.data?.refresh_token);
assert.notEqual(refreshed.data.refresh_token, token.data.refresh_token);

console.log('RC E2E: rejecting a tampered site connector URL');
const siteToken = decodeURIComponent(mcpPath.split('/').pop());
const tamperedToken = `${siteToken.slice(0, -1)}${siteToken.endsWith('A') ? 'B' : 'A'}`;
const tamperedMetadata = await request(`${gateway}/.well-known/oauth-protected-resource/mcp/s/${encodeURIComponent(tamperedToken)}`);
assert.equal(tamperedMetadata.response.status, 404);

console.log(JSON.stringify({
  event: 'wpgo_rc_onboarding_e2e',
  ok: true,
  product_version: '4.5.0-rc.1',
  checks: [
    'site_link',
    'resource_metadata',
    'oauth_challenge',
    'client_registration',
    'automatic_site_selection',
    'wordpress_approval_callback',
    'token_exchange',
    'authenticated_tools',
    'refresh_token',
    'tamper_rejection'
  ]
}));
