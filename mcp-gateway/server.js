import express from 'express';
import crypto from 'node:crypto';
import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createAuthCodeStore } from './state-store.js';
import {
  normalizeScope,
  normalizeSite,
  safeHttpsUrl,
  scopesAreSupported,
  validClientMetadataUrl,
  validPkceChallenge,
  validPkceVerifier,
  validRedirectUri
} from './security.js';

const VERSION = '1.2.0';
const port = Number(process.env.PORT || 8095);
const configuredBaseRaw = String(process.env.WPGO_MCP_PUBLIC_BASE || '').replace(/\/$/, '');
const configuredBaseUrl = configuredBaseRaw
  ? safeHttpsUrl(configuredBaseRaw, { allowLoopbackHttp: true })
  : null;
if (configuredBaseRaw && !configuredBaseUrl) {
  console.error('WPGO_MCP_PUBLIC_BASE must be HTTPS, except for loopback development URLs.');
  process.exit(1);
}
const configuredBase = configuredBaseUrl ? configuredBaseUrl.toString().replace(/\/$/, '') : '';
const rawSecret = String(process.env.WPGO_MCP_SECRET || '');
if (rawSecret.length < 32) {
  console.error('WPGO_MCP_SECRET must be at least 32 characters.');
  process.exit(1);
}
const key = crypto.createHash('sha256').update(rawSecret).digest();
const authCodes = await createAuthCodeStore();
const abilityCache = new Map();
const ABILITY_CACHE_TTL_MS = 60_000;
const ABILITY_CACHE_MAX_ENTRIES = 1000;

const BLOCKED_ABILITIES = new Set([
  'wpgo/onboarding-link',
  'wpgo/create-fleet-task',
  'wpgo/fleet-task-status',
  'wpgo/controller-onboarding-link',
  'wpgo/controller-register-site',
  'wpgo/controller-list-sites',
  'wpgo/controller-cleanup-local-credentials',
  'wpgo/controller-remove-site',
  'wpgo/controller-site-health',
  'wpgo/controller-command-read',
  'wpgo/controller-read-ability',
  'wpgo/controller-run-ability',
  'wpgo/controller-remote-approval-status',
  'wpgo/controller-fleet-snapshot',
  'wpgo/controller-dispatch',
  'wpgo/controller-run-status',
  'wpgo/controller-list-runs'
]);

function baseUrl(req) {
  if (configuredBase) return configuredBase;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const candidate = safeHttpsUrl(`${proto}://${host}`, { allowLoopbackHttp: true });
  if (!candidate) throw new Error('Unable to determine a safe public WPGo base URL.');
  return candidate.toString().replace(/\/$/, '');
}

function mcpUrl(req) {
  return `${baseUrl(req)}/mcp`;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function seal(prefix, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}.${b64url(Buffer.concat([iv, tag, ciphertext]))}`;
}

function unseal(prefix, token) {
  if (typeof token !== 'string' || !token.startsWith(`${prefix}.`)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length + 1), 'base64url');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function html(res, body, status = 200) {
  res.status(status).type('html').set({
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  }).send(body);
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function oauthErrorRedirect(redirectUri, issuer, error, description, state = '') {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

function authorizationRedirect(redirectUri, issuer, code, state = '') {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

async function fetchJson(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual'
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, headers: response.headers, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function wordpressIndex(site) {
  return fetchJson(new URL('wp-json/', site).toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': `WPGo-MCP/${VERSION}`
    }
  });
}

function registeredClientFromToken(clientId, redirectUri, issuer) {
  const sealed = unseal('wpgoclient1', clientId);
  if (!sealed) return null;
  if (sealed.issuer !== issuer) return null;
  if (!Array.isArray(sealed.redirect_uris) || !sealed.redirect_uris.includes(redirectUri)) return null;
  return sealed;
}

async function clientFromMetadataDocument(clientId, redirectUri) {
  if (!validClientMetadataUrl(clientId)) return null;
  const response = await fetchJson(clientId, {
    headers: {
      Accept: 'application/json',
      'User-Agent': `WPGo-MCP/${VERSION}`
    }
  }, 8000);
  if (!response.ok || !response.data || typeof response.data !== 'object') return null;
  if (String(response.data.client_id || '') !== clientId) return null;
  const redirectUris = Array.isArray(response.data.redirect_uris)
    ? response.data.redirect_uris.map(String)
    : [];
  if (!redirectUris.length || redirectUris.some(uri => !validRedirectUri(uri))) return null;
  if (!redirectUris.includes(redirectUri)) return null;
  if (response.data.grant_types && !response.data.grant_types.includes('authorization_code')) return null;
  if (response.data.response_types && !response.data.response_types.includes('code')) return null;
  if (response.data.token_endpoint_auth_method && response.data.token_endpoint_auth_method !== 'none') return null;
  return {
    client_id: clientId,
    client_name: String(response.data.client_name || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    application_type: String(response.data.application_type || '').slice(0, 20)
  };
}

async function loadClient(clientId, redirectUri, issuer) {
  if (!clientId || clientId.length > 4096 || redirectUri.length > 4096) return null;
  const registered = registeredClientFromToken(clientId, redirectUri, issuer);
  if (registered) return registered;
  return clientFromMetadataDocument(clientId, redirectUri);
}

function cacheAbilities(cacheKey, abilities) {
  abilityCache.delete(cacheKey);
  abilityCache.set(cacheKey, { abilities, expiresAt: Date.now() + ABILITY_CACHE_TTL_MS });
  while (abilityCache.size > ABILITY_CACHE_MAX_ENTRIES) {
    const oldest = abilityCache.keys().next().value;
    if (!oldest) break;
    abilityCache.delete(oldest);
  }
}

async function fetchAbilities(auth) {
  const cacheKey = crypto.createHash('sha256')
    .update(`${auth.site_url}|${auth.username}`)
    .digest('hex');
  const cached = abilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    abilityCache.delete(cacheKey);
    abilityCache.set(cacheKey, cached);
    return cached.abilities;
  }
  if (cached) abilityCache.delete(cacheKey);

  const abilities = [];
  for (let page = 1; page <= 10; page++) {
    const url = new URL('wp-json/wp-abilities/v1/abilities', auth.site_url);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await fetchJson(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: basicAuth(auth.username, auth.password),
        'User-Agent': `WPGo-MCP/${VERSION}`
      }
    });
    if (!response.ok || !Array.isArray(response.data)) {
      throw new Error(`WordPress abilities request failed (${response.status}).`);
    }
    abilities.push(...response.data);
    const totalPages = Number(response.headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || response.data.length < 100) break;
  }

  const filtered = abilities.filter(ability =>
    typeof ability?.name === 'string' &&
    ability.name.startsWith('wpgo/') &&
    !BLOCKED_ABILITIES.has(ability.name) &&
    !ability.name.startsWith('wpgo/controller-')
  );
  cacheAbilities(cacheKey, filtered);
  return filtered;
}

function toolName(abilityName) {
  return abilityName
    .replace(/^wpgo\//, 'wpgo__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
}

function toolSchema(ability) {
  const schema = ability?.input_schema && typeof ability.input_schema === 'object'
    ? structuredClone(ability.input_schema)
    : { type: 'object', additionalProperties: false };
  if (schema.type === 'object' || !schema.type) return { schema, unwrap: false };
  return {
    schema: {
      type: 'object',
      properties: { input: schema },
      required: ['input'],
      additionalProperties: false
    },
    unwrap: true
  };
}

async function executeAbility(auth, ability, args, unwrap) {
  const annotations = ability?.meta?.annotations || {};
  const readonly = annotations.readonly === true;
  const destructive = annotations.destructive === true && annotations.idempotent === true;
  const method = readonly ? 'GET' : destructive ? 'DELETE' : 'POST';
  const actualInput = unwrap ? args?.input : (args ?? {});
  const actionLink = ability?._links?.['wp:action-run']?.[0]?.href;
  const linkUrl = actionLink ? safeHttpsUrl(actionLink) : null;
  const runUrl = linkUrl
    ? new URL(linkUrl)
    : new URL(`wp-json/wp-abilities/v1/abilities/${ability.name}/run`, auth.site_url);

  if (runUrl.origin !== new URL(auth.site_url).origin) {
    throw new Error('Refused cross-origin WordPress ability URL.');
  }

  const headers = {
    Accept: 'application/json',
    Authorization: basicAuth(auth.username, auth.password),
    'User-Agent': `WPGo-MCP/${VERSION}`
  };
  const options = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ input: actualInput });
  } else if (
    actualInput !== undefined &&
    actualInput !== null &&
    !(typeof actualInput === 'object' && !Array.isArray(actualInput) && Object.keys(actualInput).length === 0)
  ) {
    runUrl.searchParams.set('input', JSON.stringify(actualInput));
  }

  const response = await fetchJson(runUrl.toString(), options, 30_000);
  if (!response.ok) {
    const message = response.data?.message || response.data?.error || response.text || `WordPress returned ${response.status}`;
    return {
      content: [{ type: 'text', text: `WPGo action failed: ${String(message).slice(0, 4000)}` }],
      isError: true
    };
  }

  const result = response.data ?? response.text ?? null;
  return {
    content: [{
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    }],
    ...(result && typeof result === 'object' && !Array.isArray(result)
      ? { structuredContent: result }
      : {})
  };
}

async function buildMcpServer(ctx) {
  const token = ctx?.authInfo?.token || '';
  const auth = unseal('wpgoaccess1', token);
  if (!auth) throw new Error('Invalid WPGo access token.');
  const abilities = await fetchAbilities(auth);
  const server = new McpServer(
    { name: 'WPGo', version: VERSION },
    { capabilities: { tools: {} } }
  );
  for (const ability of abilities) {
    const { schema, unwrap } = toolSchema(ability);
    server.registerTool(toolName(ability.name), {
      title: ability.label || ability.name,
      description: `${ability.description || ability.label || ability.name}\nWPGo ability: ${ability.name}`,
      inputSchema: fromJsonSchema(schema)
    }, async args => executeAbility(auth, ability, args, unwrap));
  }
  return server;
}

function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }, Math.min(windowMs, 60_000));
  cleanup.unref();

  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = String(req.ip || req.socket?.remoteAddress || 'unknown');
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'temporarily_unavailable' });
    }
    next();
  };
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);
const oauthLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 300 });
const registrationLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30 });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  const ready = authCodes.ready();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'wpgo-mcp-gateway',
    version: VERSION,
    mcp_url: mcpUrl(req),
    oauth: true,
    oauth_code_store: authCodes.mode(),
    oauth_shared_state_required: authCodes.requiresShared(),
    protocols: ['2026-07-28', 'legacy-stateless'],
    wordpress_abilities: true,
    client_id_metadata_documents: true,
    dynamic_client_registration: true
  });
});

app.get(
  ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
  (req, res) => res.json({
    resource: mcpUrl(req),
    authorization_servers: [baseUrl(req)],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header']
  })
);

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const issuer = baseUrl(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  });
});

app.post('/oauth/register', registrationLimiter, (req, res) => {
  const rawRedirectUris = Array.isArray(req.body?.redirect_uris)
    ? req.body.redirect_uris.map(String)
    : [];
  const redirectUris = [...new Set(rawRedirectUris)].slice(0, 10);
  if (
    !redirectUris.length ||
    rawRedirectUris.length > 10 ||
    redirectUris.some(uri => !validRedirectUri(uri))
  ) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  const requestedGrantTypes = Array.isArray(req.body?.grant_types) ? req.body.grant_types.map(String) : [];
  const requestedResponseTypes = Array.isArray(req.body?.response_types) ? req.body.response_types.map(String) : [];
  const requestedAuthMethod = String(req.body?.token_endpoint_auth_method || 'none');
  if (requestedGrantTypes.length && !requestedGrantTypes.includes('authorization_code')) {
    return res.status(400).json({ error: 'invalid_client_metadata' });
  }
  if (requestedResponseTypes.length && !requestedResponseTypes.includes('code')) {
    return res.status(400).json({ error: 'invalid_client_metadata' });
  }
  if (requestedAuthMethod !== 'none') {
    return res.status(400).json({ error: 'invalid_client_metadata' });
  }

  const inferredNative = redirectUris.some(uri => new URL(uri).protocol === 'http:');
  const requestedApplicationType = String(req.body?.application_type || '');
  const applicationType = ['native', 'web'].includes(requestedApplicationType)
    ? requestedApplicationType
    : (inferredNative ? 'native' : 'web');
  const issuer = baseUrl(req);
  const issuedAt = Math.floor(Date.now() / 1000);
  const client = {
    issuer,
    client_name: String(req.body?.client_name || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    application_type: applicationType,
    iat: issuedAt
  };
  const clientId = seal('wpgoclient1', client);
  res.set('Cache-Control', 'no-store');
  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: client.client_name,
    redirect_uris: redirectUris,
    application_type: applicationType,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
});

app.get('/oauth/authorize', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const responseType = String(req.query.response_type || '');
  const clientId = String(req.query.client_id || '');
  const redirectUri = String(req.query.redirect_uri || '');
  const challenge = String(req.query.code_challenge || '');
  const challengeMethod = String(req.query.code_challenge_method || '');
  const state = String(req.query.state || '');
  const resource = String(req.query.resource || mcpUrl(req));
  const scopes = normalizeScope(req.query.scope || 'mcp');

  if (
    responseType !== 'code' ||
    !clientId ||
    !validRedirectUri(redirectUri) ||
    !validPkceChallenge(challenge) ||
    challengeMethod !== 'S256' ||
    resource !== mcpUrl(req)
  ) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  if (!scopesAreSupported(scopes)) {
    return res.redirect(302, oauthErrorRedirect(
      redirectUri,
      issuer,
      'invalid_scope',
      'WPGo currently supports only the mcp scope.',
      state
    ));
  }

  const client = await loadClient(clientId, redirectUri, issuer);
  if (!client) return res.status(400).json({ error: 'invalid_client' });

  const flow = seal('wpgoflow1', {
    issuer,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
    resource,
    scope: 'mcp',
    client_name: client.client_name || 'MCP client',
    exp: Math.floor(Date.now() / 1000) + 600
  });

  return html(res, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect WPGo</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;margin:0}.card{max-width:560px;margin:8vh auto;background:#fff;padding:32px;border-radius:16px;box-shadow:0 12px 35px #0001}h1{margin-top:0}label{font-weight:700;display:block;margin:22px 0 8px}input{width:100%;box-sizing:border-box;padding:13px;border:1px solid #cbd3df;border-radius:9px;font-size:16px}button{margin-top:18px;background:#1769e0;color:white;border:0;border-radius:9px;padding:13px 20px;font-weight:700;font-size:16px;cursor:pointer}.muted{color:#657083;line-height:1.5}</style></head><body><div class="card"><h1>Connect WPGo</h1><p class="muted">Connect ${esc(client.client_name || 'your AI')} to the WordPress site where WPGo is installed. You will be sent to WordPress to approve access.</p><form method="post" action="/oauth/authorize/site"><input type="hidden" name="flow" value="${esc(flow)}"><label>WordPress site</label><input name="site" type="url" placeholder="https://example.com" required autocomplete="url"><button type="submit">Continue to WordPress</button></form><p class="muted">WPGo never asks for your normal WordPress password.</p></div></body></html>`);
});

app.post('/oauth/authorize/site', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const flow = unseal('wpgoflow1', String(req.body?.flow || ''));
  if (!flow || flow.issuer !== issuer) {
    return html(res, '<h1>Connection expired</h1><p>Return to your AI client and connect WPGo again.</p>', 400);
  }

  const site = normalizeSite(req.body?.site);
  if (!site) {
    return html(res, '<h1>Invalid site</h1><p>Enter the HTTPS address of your WordPress site.</p>', 400);
  }

  const index = await wordpressIndex(site);
  if (!index.ok || !index.data) {
    return html(res, '<h1>WordPress not detected</h1><p>WPGo could not read the WordPress REST API at that address.</p>', 400);
  }

  const routes = index.data.routes || {};
  const hasWpgo = Object.keys(routes).some(route => route.startsWith('/wpgo/v1'));
  if (!hasWpgo) {
    return html(res, '<h1>WPGo not detected</h1><p>Install and activate WPGo on this WordPress site, then try again.</p>', 400);
  }

  const authEndpointRaw = index.data?.authentication?.['application-passwords']?.endpoints?.authorization;
  const authEndpoint = safeHttpsUrl(authEndpointRaw);
  if (!authEndpoint || authEndpoint.origin !== new URL(site).origin) {
    return html(res, '<h1>WordPress authorization unavailable</h1><p>This site does not currently expose the secure WordPress application authorization flow required by WPGo.</p>', 400);
  }

  const appId = crypto.randomUUID();
  const nextFlow = seal('wpgoflow1', {
    ...flow,
    site,
    app_id: appId,
    exp: Math.floor(Date.now() / 1000) + 600
  });
  const success = new URL('/oauth/wp/callback', issuer);
  success.searchParams.set('flow', nextFlow);
  const reject = new URL('/oauth/wp/reject', issuer);
  reject.searchParams.set('flow', nextFlow);
  const authorizeUrl = new URL(authEndpoint);
  authorizeUrl.searchParams.set('app_name', 'WPGo AI Connector');
  authorizeUrl.searchParams.set('app_id', appId);
  authorizeUrl.searchParams.set('success_url', success.toString());
  authorizeUrl.searchParams.set('reject_url', reject.toString());
  return res.redirect(302, authorizeUrl.toString());
});

app.get('/oauth/wp/reject', oauthLimiter, (req, res) => {
  const issuer = baseUrl(req);
  const flow = unseal('wpgoflow1', String(req.query.flow || ''));
  if (!flow || flow.issuer !== issuer) return html(res, '<h1>Connection cancelled</h1>', 400);
  return res.redirect(302, oauthErrorRedirect(
    flow.redirect_uri,
    issuer,
    'access_denied',
    'WordPress authorization was cancelled.',
    flow.state
  ));
});

app.get('/oauth/wp/callback', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const flow = unseal('wpgoflow1', String(req.query.flow || ''));
  if (!flow || flow.issuer !== issuer) return html(res, '<h1>Connection expired</h1>', 400);

  const siteReturned = normalizeSite(req.query.site_url);
  const username = String(req.query.user_login || '');
  const password = String(req.query.password || '');
  if (
    !siteReturned ||
    siteReturned !== flow.site ||
    !username ||
    username.length > 255 ||
    password.length < 12 ||
    password.length > 512
  ) {
    return res.redirect(302, oauthErrorRedirect(
      flow.redirect_uri,
      issuer,
      'access_denied',
      'WordPress did not return a valid authorization.',
      flow.state
    ));
  }

  const auth = { site_url: flow.site, username, password };
  try {
    const abilities = await fetchAbilities(auth);
    if (!abilities.length) throw new Error('No WPGo abilities found.');
  } catch {
    return res.redirect(302, oauthErrorRedirect(
      flow.redirect_uri,
      issuer,
      'access_denied',
      'WPGo could not verify the WordPress connection.',
      flow.state
    ));
  }

  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 300_000;
  const payload = seal('wpgocode1', {
    ...flow,
    username,
    password,
    exp: Math.floor(expiresAt / 1000)
  });
  try {
    await authCodes.put(code, { payload, expiresAt });
  } catch {
    return res.redirect(302, oauthErrorRedirect(
      flow.redirect_uri,
      issuer,
      'temporarily_unavailable',
      'WPGo could not securely complete the connection. Please try again.',
      flow.state
    ));
  }

  res.set('Cache-Control', 'no-store');
  return res.redirect(302, authorizationRedirect(flow.redirect_uri, issuer, code, flow.state));
});

app.post('/oauth/token', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const resource = mcpUrl(req);
  const grant = String(req.body?.grant_type || '');
  const clientId = String(req.body?.client_id || '');
  res.set('Cache-Control', 'no-store');

  if (!clientId || clientId.length > 4096) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  if (grant === 'authorization_code') {
    const code = String(req.body?.code || '');
    const verifier = String(req.body?.code_verifier || '');
    const redirectUri = String(req.body?.redirect_uri || '');
    if (!code || code.length > 512 || !validPkceVerifier(verifier) || !validRedirectUri(redirectUri)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    let stored;
    try {
      stored = await authCodes.take(code);
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    const row = stored?.payload ? unseal('wpgocode1', stored.payload) : null;
    if (
      !row ||
      stored.expiresAt < Date.now() ||
      row.issuer !== issuer ||
      row.resource !== resource ||
      row.client_id !== clientId ||
      row.redirect_uri !== redirectUri
    ) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!secureEqual(expected, row.code_challenge)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const now = Math.floor(Date.now() / 1000);
    const base = {
      issuer,
      client_id: clientId,
      site_url: row.site,
      username: row.username,
      password: row.password,
      resource,
      scopes: ['mcp']
    };
    const access = seal('wpgoaccess1', { ...base, iat: now, exp: now + 3600 });
    const refresh = seal('wpgorefresh1', { ...base, iat: now, exp: now + 86400 * 30 });
    return res.json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: 'mcp'
    });
  }

  if (grant === 'refresh_token') {
    const refreshToken = String(req.body?.refresh_token || '');
    const row = unseal('wpgorefresh1', refreshToken);
    if (
      !row ||
      row.issuer !== issuer ||
      row.resource !== resource ||
      row.client_id !== clientId ||
      !Array.isArray(row.scopes) ||
      !row.scopes.includes('mcp')
    ) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    const access = seal('wpgoaccess1', { ...row, iat: now, exp: now + 3600 });
    return res.json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: 'mcp'
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

async function mcpAuth(req, res, next) {
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const row = unseal('wpgoaccess1', token);
  const issuer = baseUrl(req);
  const resource = mcpUrl(req);
  const metadata = `${issuer}/.well-known/oauth-protected-resource/mcp`;

  if (!row || row.issuer !== issuer || row.resource !== resource) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", error="invalid_token"`);
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (!Array.isArray(row.scopes) || !row.scopes.includes('mcp')) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="mcp"`);
    return res.status(403).json({ error: 'insufficient_scope' });
  }

  req.auth = {
    token,
    clientId: row.client_id,
    scopes: ['mcp'],
    expiresAt: row.exp,
    resource: new URL(resource),
    resourceMetadataUrl: new URL(metadata)
  };
  return next();
}

app.all('/mcp', mcpAuth, (req, res) => void nodeMcpHandler(req, res, req.body));

app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    event: 'gateway_error',
    path: req.path,
    message: String(err?.message || err).slice(0, 500)
  }));
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'server_error' });
});

const httpServer = app.listen(port, '0.0.0.0', () => {
  console.log(`WPGo MCP gateway ${VERSION} listening on ${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'gateway_shutdown', signal }));
  httpServer.close(async () => {
    await authCodes.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
