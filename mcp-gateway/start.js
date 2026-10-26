import crypto from 'node:crypto';
import './outbound-guard.js';
import { resourceForSite } from './site-link.js';
import './server-rc.js';

const port = Number(process.env.PORT || 8095);
const local = `http://127.0.0.1:${port}`;
const publicBase = String(process.env.WPGO_MCP_PUBLIC_BASE || local).replace(/\/$/, '');
const secret = String(process.env.WPGO_MCP_SECRET || '');

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', ...options });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, ok: response.ok, text, data, headers: response.headers };
}

async function selfTest() {
  const checks = {};
  try {
    const health = await request(`${local}/health`);
    checks.health = health.ok && health.data?.ok === true;
    checks.version = health.data?.version === '1.4.1-rc.2' && health.data?.product_version === '4.5.0-rc.2';
    checks.shared_state = health.data?.oauth_shared_state_required
      ? health.data?.oauth_code_store === 'redis'
      : true;
    checks.approval_proxy = health.data?.approval_proxy === true;
    checks.wordpress_first = health.data?.wordpress_first_onboarding === true && health.data?.site_specific_mcp_urls === true;

    const protectedResource = await request(`${local}/.well-known/oauth-protected-resource/mcp`);
    checks.resource_metadata =
      protectedResource.ok &&
      protectedResource.data?.resource === `${publicBase}/mcp` &&
      Array.isArray(protectedResource.data?.authorization_servers) &&
      protectedResource.data.authorization_servers.includes(publicBase);

    const siteResource = resourceForSite(publicBase, 'https://example.com/blog/', secret);
    const sitePath = new URL(siteResource).pathname;
    const siteMetadata = await request(`${local}/.well-known/oauth-protected-resource${sitePath}`);
    checks.site_resource_metadata =
      siteMetadata.ok &&
      siteMetadata.data?.resource === siteResource &&
      siteMetadata.data?.authorization_servers?.includes(publicBase);

    const siteMcp = await request(`${local}${sitePath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    checks.site_mcp_oauth_challenge =
      siteMcp.status === 401 &&
      String(siteMcp.headers.get('www-authenticate') || '').includes(`/.well-known/oauth-protected-resource${sitePath}`);

    const authMetadata = await request(`${local}/.well-known/oauth-authorization-server`);
    checks.authorization_metadata =
      authMetadata.ok &&
      authMetadata.data?.issuer === publicBase &&
      authMetadata.data?.authorization_endpoint === `${publicBase}/oauth/authorize` &&
      authMetadata.data?.token_endpoint === `${publicBase}/oauth/token` &&
      authMetadata.data?.client_id_metadata_document_supported === true &&
      authMetadata.data?.authorization_response_iss_parameter_supported === true &&
      authMetadata.data?.code_challenge_methods_supported?.includes('S256');

    const insecureRegistration = await request(`${local}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'WPGo insecure self-test',
        redirect_uris: ['http://client.example.test/callback']
      })
    });
    checks.insecure_redirect_rejected = insecureRegistration.status === 400;

    const registration = await request(`${local}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'WPGo startup self-test',
        application_type: 'web',
        redirect_uris: ['https://client.example.test/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    });
    checks.dynamic_client_registration =
      registration.status === 201 &&
      typeof registration.data?.client_id === 'string' &&
      registration.data?.application_type === 'web' &&
      registration.data?.token_endpoint_auth_method === 'none';

    if (checks.dynamic_client_registration) {
      const verifier = 'wpgo-startup-verifier-012345678901234567890123456789';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const authorizeUrl = new URL(`${local}/oauth/authorize`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', registration.data.client_id);
      authorizeUrl.searchParams.set('redirect_uri', 'https://client.example.test/callback');
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('resource', `${publicBase}/mcp`);
      authorizeUrl.searchParams.set('scope', 'mcp');
      const authorization = await request(authorizeUrl.toString());
      checks.authorization_page =
        authorization.status === 200 &&
        authorization.text.includes('compatibility connection route');
    }

    const badPkceUrl = new URL(`${local}/oauth/authorize`);
    badPkceUrl.searchParams.set('response_type', 'code');
    badPkceUrl.searchParams.set('client_id', registration.data?.client_id || 'invalid');
    badPkceUrl.searchParams.set('redirect_uri', 'https://client.example.test/callback');
    badPkceUrl.searchParams.set('code_challenge', 'short');
    badPkceUrl.searchParams.set('code_challenge_method', 'S256');
    badPkceUrl.searchParams.set('resource', `${publicBase}/mcp`);
    const badPkce = await request(badPkceUrl.toString());
    checks.invalid_pkce_rejected = badPkce.status === 400;

    const mcp = await request(`${local}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    checks.mcp_oauth_challenge =
      mcp.status === 401 &&
      String(mcp.headers.get('www-authenticate') || '').includes('resource_metadata=');
  } catch (error) {
    checks.exception = String(error?.message || error).slice(0, 300);
  }

  const required = [
    'health',
    'version',
    'shared_state',
    'approval_proxy',
    'wordpress_first',
    'resource_metadata',
    'site_resource_metadata',
    'site_mcp_oauth_challenge',
    'authorization_metadata',
    'insecure_redirect_rejected',
    'dynamic_client_registration',
    'authorization_page',
    'invalid_pkce_rejected',
    'mcp_oauth_challenge'
  ];
  console.log(JSON.stringify({
    event: 'wpgo_mcp_self_test',
    version: '4.5.0-rc.2',
    ok: required.every(check => checks[check] === true),
    checks
  }));
}

setTimeout(() => void selfTest(), 1200);
